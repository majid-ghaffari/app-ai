#!/usr/bin/env bash
#
# deploy-integration-bridge-token.sh — apply the integration bridge caller-auth token
# (PERSONALIZER_INTEGRATION_BRIDGE_TOKEN) to BOTH deployment targets from one place:
#
#   (1) Cloudflare  — the app-ai Worker secret `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`, read by
#       src/toolsets/integration-bridge.ts and sent as X-Personalizer-Integration-Bridge-Token.
#       (Preflight: `wrangler` installed + `wrangler login` done.)
#
#   (2) Kubernetes  — one key on Personalizer's `app-settings` Secret (envFrom'd by the
#       api-web Deployment). Personalizer reads env vars with the `LIMESPOT_` prefix
#       (HostBuilderDefaults → AddEnvironmentVariables("LIMESPOT_")), so the key
#       maps onto config `IntegrationBridge:Clients:0:Tokens:{slot}`
#       (caller Name = "app-ai", per Configs/appsettings.json).
#
# This script WRITES the token to live infrastructure. It never prints the token
# and always confirms before mutating a live cluster.
#
# ---------------------------------------------------------------------------
# GROUNDED DEPLOY FACTS (from the argo GitOps repo + brain, verified in source)
# ---------------------------------------------------------------------------
#   environment | kube Secret            | namespace | Deployment (restart)
#   ------------|------------------------|-----------|----------------------
#   production  | app-settings           | default   | api-web
#   staging     | app-settings-preview   | default   | api-web-preview
#
#   * brain/base/deployment/api/api-web.yaml          — envFrom secretRef app-settings
#   * brain/base/deployment/api/preview/api-web-preview.yaml
#       — envFrom secretRefs app-settings THEN app-settings-preview (the latter
#         is listed last, so it OVERRIDES; staging tokens belong in it).
#   * No namespace is declared for the brain kustomization, so it lands in the
#     `default` namespace unless the Argo CD Application overrides it. Override
#     with --namespace if your cluster differs.
#   * The `app-settings` / `app-settings-preview` Secrets are NOT defined in the
#     argo repo — they are managed out-of-band, so we PATCH (merge) a single key
#     and never recreate the Secret (would clobber every other key).
#
#   Cloudflare: wrangler.toml defines ONE worker ("app-ai") with NO [env.*]
#   blocks — it is production-only, auto-deployed from main. There is NO separate
#   staging Cloudflare Worker, so `--env` is never passed and the Cloudflare step
#   is only valid for `production`. Requesting it for `staging` is refused.
#
# ---------------------------------------------------------------------------
# TOKEN VALUES
# ---------------------------------------------------------------------------
#   production / staging : `openssl rand -hex 32`
#   local dev            : the readable constant `local-dev-integration-bridge-token`
#                          (lives in .dev.vars only — NEVER deployed via this
#                          script; do not push it to Cloudflare or the cluster).
#
# ---------------------------------------------------------------------------
# TWO-TOKEN ROTATION RUNBOOK (Personalizer accepts current + next per caller)
# ---------------------------------------------------------------------------
#   Personalizer validates the incoming token against ALL tokens in the caller's list,
#   so you can keep two active at once (slot 0 = current, slot 1 = next):
#
#     1. Stage the NEW token into the cluster's spare slot (does not affect
#        traffic yet — Cloudflare still sends the old token):
#          ./scripts/deploy-integration-bridge-token.sh production --kube-only --slot 1 --token-stdin < newtoken
#          # (restart api-web when prompted so Personalizer loads slot 1)
#     2. Flip Cloudflare to the NEW token (traffic now presents the new value,
#        which Personalizer already accepts via slot 1):
#          ./scripts/deploy-integration-bridge-token.sh production --cf-only --token-stdin < newtoken
#     3. Retire the OLD token by overwriting slot 0 with the new value (or blank
#        it), so only the new token remains valid:
#          ./scripts/deploy-integration-bridge-token.sh production --kube-only --slot 0 --token-stdin < newtoken
#          # (restart api-web again)
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#   ./scripts/deploy-integration-bridge-token.sh <production|staging> [options]
#
#   Token input (pick ONE — the token is NEVER a plain positional arg):
#     --token-stdin           read the token from stdin (piped or heredoc)
#     --token-env VAR         read the token from environment variable VAR
#     (default)               interactive hidden `read -rs` prompt
#
#   Target selection:
#     --cf-only               Cloudflare Worker secret only
#     --kube-only             Kubernetes Secret only
#     (default)               both (production only; staging is kube-only)
#
#   Rotation / cluster options:
#     --slot 0|1              kube token slot (default 0) → Tokens__{slot}
#     --namespace NS          kube namespace (default: default)
#     --restart               after patching, run the api-web rollout restart
#                             (otherwise the exact command is printed, not run)
#
#   Safety:
#     --dry-run               print masked commands and exit; mutate nothing
#     --yes                   skip the interactive confirm before live mutation
#     -h | --help             this help
#
# EXAMPLES
#   printf '%s' "$TOK" | ./scripts/deploy-integration-bridge-token.sh production --token-stdin
#   TOK=$(openssl rand -hex 32); TOK="$TOK" ./scripts/deploy-integration-bridge-token.sh production --token-env TOK
#   ./scripts/deploy-integration-bridge-token.sh staging --kube-only            # hidden prompt
#
set -euo pipefail

readonly CF_SECRET_NAME="PERSONALIZER_INTEGRATION_BRIDGE_TOKEN"
readonly KUBE_KEY_BASE="LIMESPOT_IntegrationBridge__Clients__0__Tokens"

usage() {
  # Print the header comment block (lines starting with '#') as help text.
  sed -n '3,120p' "$0" | sed -e 's/^# \{0,1\}//' -e 's/^#$//'
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# --- masked fingerprint (never reveals the token) --------------------------
fingerprint() {
  local tok="$1" len hash
  len="${#tok}"
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$tok" | shasum -a 256 | cut -c1-12)"
  elif command -v sha256sum >/dev/null 2>&1; then
    hash="$(printf '%s' "$tok" | sha256sum | cut -c1-12)"
  else
    hash="unknown"
  fi
  if [[ "$len" -ge 8 ]]; then
    printf '%s…%s (len=%s, sha256=%s…)' "${tok:0:4}" "${tok: -4}" "$len" "$hash"
  else
    printf '***** (len=%s, sha256=%s…)' "$len" "$hash"
  fi
}

# --- arg parsing -----------------------------------------------------------
ENVIRONMENT=""
TOKEN_SOURCE="prompt"   # prompt | stdin | env
TOKEN_ENV_VAR=""
DO_CF=1
DO_KUBE=1
TARGET_EXPLICIT=0
SLOT="0"
NAMESPACE="default"
DRY_RUN=0
ASSUME_YES=0
DO_RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    production|staging)
      [[ -n "$ENVIRONMENT" ]] && die "environment already set to '$ENVIRONMENT'"
      ENVIRONMENT="$1" ;;
    --token-stdin) TOKEN_SOURCE="stdin" ;;
    --token-env)
      TOKEN_SOURCE="env"
      shift; [[ $# -gt 0 ]] || die "--token-env needs a VARIABLE name"
      TOKEN_ENV_VAR="$1" ;;
    --cf-only)   DO_CF=1; DO_KUBE=0; TARGET_EXPLICIT=1 ;;
    --kube-only) DO_CF=0; DO_KUBE=1; TARGET_EXPLICIT=1 ;;
    --slot)
      shift; [[ $# -gt 0 ]] || die "--slot needs a value (0 or 1)"
      SLOT="$1" ;;
    --namespace)
      shift; [[ $# -gt 0 ]] || die "--namespace needs a value"
      NAMESPACE="$1" ;;
    --restart)  DO_RESTART=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    *) die "unknown argument: '$1' (see --help)" ;;
  esac
  shift
done

# --- validate ---------------------------------------------------------------
case "$ENVIRONMENT" in
  production|staging) ;;
  "") die "missing environment. Usage: $0 <production|staging> [options]" ;;
  *)  die "invalid environment '$ENVIRONMENT' (expected production|staging)" ;;
esac

case "$SLOT" in 0|1) ;; *) die "invalid --slot '$SLOT' (expected 0 or 1)" ;; esac

# Map environment → grounded kube facts.
if [[ "$ENVIRONMENT" == "production" ]]; then
  KUBE_SECRET="app-settings"
  DEPLOYMENT="api-web"
else
  KUBE_SECRET="app-settings-preview"
  DEPLOYMENT="api-web-preview"
fi
KUBE_KEY="${KUBE_KEY_BASE}__${SLOT}"

# Cloudflare is production-only (no staging Worker exists in wrangler.toml).
if [[ "$ENVIRONMENT" == "staging" ]]; then
  if [[ "$TARGET_EXPLICIT" -eq 1 && "$DO_CF" -eq 1 ]]; then
    die "there is NO staging Cloudflare Worker (app-ai is prod-only, no [env.*] in wrangler.toml). Use --kube-only for staging."
  fi
  # Default target on staging = kube only.
  DO_CF=0
fi

[[ "$DO_CF" -eq 0 && "$DO_KUBE" -eq 0 ]] && die "nothing to do (both targets disabled)"

# --- acquire token securely (never a positional arg) ------------------------
TOKEN=""
case "$TOKEN_SOURCE" in
  stdin)
    IFS= read -r TOKEN || true ;;
  env)
    [[ -n "${!TOKEN_ENV_VAR:-}" ]] || die "env var '$TOKEN_ENV_VAR' is empty/unset"
    TOKEN="${!TOKEN_ENV_VAR}" ;;
  prompt)
    printf 'Enter %s value for %s (input hidden): ' "$CF_SECRET_NAME" "$ENVIRONMENT" >&2
    read -rs TOKEN
    printf '\n' >&2 ;;
esac

# --- token sanity -----------------------------------------------------------
if [[ -z "${TOKEN//[[:space:]]/}" ]]; then
  die "token is empty or whitespace-only — refusing to deploy a blank token."
fi
if [[ "$TOKEN" == "local-dev-integration-bridge-token" ]]; then
  die "that is the LOCAL DEV constant (.dev.vars) — it must never be deployed. Generate one with: openssl rand -hex 32"
fi

FP="$(fingerprint "$TOKEN")"

echo "==============================================================="
echo " deploy-integration-bridge-token  —  environment: $ENVIRONMENT"
echo "   token fingerprint : $FP"
echo "   targets           : Cloudflare=$([[ $DO_CF -eq 1 ]] && echo yes || echo no)  Kubernetes=$([[ $DO_KUBE -eq 1 ]] && echo yes || echo no)"
[[ "$DO_KUBE" -eq 1 ]] && echo "   kube secret/key   : $KUBE_SECRET  ns=$NAMESPACE  key=$KUBE_KEY  (deployment=$DEPLOYMENT)"
[[ "$DO_CF"   -eq 1 ]] && echo "   cloudflare secret : $CF_SECRET_NAME  (worker=app-ai, prod)"
echo "==============================================================="

# --- confirmation before any live mutation ----------------------------------
confirm() {
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local prompt="$1" reply
  printf '%s [y/N]: ' "$prompt" >&2
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted by user."
}

# =========================== Cloudflare step ================================
if [[ "$DO_CF" -eq 1 ]]; then
  echo
  echo ">> Cloudflare Worker secret ($CF_SECRET_NAME, worker=app-ai)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "   [dry-run] printf '%s' '<TOKEN:$FP>' | wrangler secret put $CF_SECRET_NAME"
  else
    command -v wrangler >/dev/null 2>&1 || die "wrangler not found (npm i, then \`wrangler login\`)."
    echo "   (requires an authenticated wrangler session — run 'wrangler login' if this fails)"
    confirm "   Push $CF_SECRET_NAME to the PRODUCTION app-ai Worker?"
    # No --env: wrangler.toml has no [env.*] blocks (single prod worker).
    printf '%s' "$TOKEN" | wrangler secret put "$CF_SECRET_NAME"
    echo "   Cloudflare secret updated."
  fi
fi

# =========================== Kubernetes step ================================
if [[ "$DO_KUBE" -eq 1 ]]; then
  echo
  echo ">> Kubernetes Secret ($KUBE_SECRET, ns=$NAMESPACE, key=$KUBE_KEY)"
  TOKEN_B64="$(printf '%s' "$TOKEN" | base64 | tr -d '\n')"
  PATCH_JSON="{\"data\":{\"${KUBE_KEY}\":\"${TOKEN_B64}\"}}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "   [dry-run] kubectl patch secret $KUBE_SECRET -n $NAMESPACE --type merge -p '{\"data\":{\"$KUBE_KEY\":\"<base64(TOKEN:$FP)>\"}}'"
    echo "   [dry-run] kubectl rollout restart deployment/$DEPLOYMENT -n $NAMESPACE"
  else
    command -v kubectl >/dev/null 2>&1 || die "kubectl not found."
    CTX="$(kubectl config current-context 2>/dev/null || echo '<none>')"
    echo "   kube context : $CTX"
    [[ "$CTX" == "<none>" ]] && die "no current kube context set."
    confirm "   Patch $KUBE_SECRET/$KUBE_KEY in ns=$NAMESPACE on context '$CTX'?"
    kubectl patch secret "$KUBE_SECRET" -n "$NAMESPACE" --type merge -p "$PATCH_JSON"
    echo "   Kube Secret patched (only key $KUBE_KEY changed; other keys untouched)."
    echo
    echo "   envFrom secrets are injected at pod start — Personalizer will NOT see the new"
    echo "   value until the pods restart. Required command:"
    echo "     kubectl rollout restart deployment/$DEPLOYMENT -n $NAMESPACE"
    if [[ "$DO_RESTART" -eq 1 ]]; then
      confirm "   Run the rollout restart of $DEPLOYMENT now?"
      kubectl rollout restart "deployment/$DEPLOYMENT" -n "$NAMESPACE"
      echo "   Rollout restart triggered."
    else
      echo "   (not run — pass --restart to trigger it.)"
    fi
  fi
fi

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run complete — nothing was mutated. Token fingerprint: $FP"
else
  echo "Done. Token fingerprint: $FP"
fi
