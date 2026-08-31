# LimeSpot agent rules — app-ai

Codex reads this file; Claude Code reads `CLAUDE.md` beside it. Both carry the same rules, because a
rule that reaches one agent and not the other is the failure the workspace repository exists to
prevent.

The rules below are inlined rather than referenced. Codex has no include mechanism, so a pointer is
a hint it may skip, while this text is always in context. Codex also stops walking at the nearest
`.git`, which is why these rules live here and not only in the workspace repository above.

Depth lives in the workspace repository's `_standards/*.md`, read on demand — `engineering`,
`testing`, `documentation-and-comments`, `git-and-approval`, `architecture`, `naming`, `security`,
`web-ui`. From inside this repository they resolve at `../_standards/`. Shared agent skills are
canonical in `../.agents/skills/<skill-name>/SKILL.md`, which Codex reads directly.

What is specific to this repository — its gate commands, its commit-message and authorship rules,
its deploy targets — lives in this repository's own `CLAUDE.md`, and this file never restates it.

## Always-in-context hard rules (everything else is a pointer)

1. **Approval gates are separate.** Commit ≠ push ≠ PR ≠ deploy — each needs its own explicit human
   authorization; nothing escalates itself. (`_standards/git-and-approval.md`)
2. **Reproduction-first for reported behavior bugs.** The first artifact is a failing test driving
   the REAL path — a real user gesture for UI, the real HTTP/queue/integration path for backend —
   never a directly-called handler, never jsdom. (`_standards/testing.md`)
3. **No issue/ticket numbers or change-tracking in code, docs, or any `CLAUDE.md`.** No `pulse#`,
   `support#`, bare `#N`, PR/phase numbers, or dates on architectural statements — git history and
   the PR hold that. Cross-reference by stable identifier (doc path + section, or type/method name).
   (`_standards/documentation-and-comments.md`)
4. **No AI or assistant attribution, anywhere.** No `Co-Authored-By:` naming a model or a tool, no
   session or generation links, no "generated with" tagline — not in commit messages, pull request
   bodies, or review comments. Each repository's own `CLAUDE.md` names the human co-author trailer
   its `feat` and `refactor` commits carry, and that is the only trailer.
   (`_standards/git-and-approval.md`)
5. **`master` and `main` are read-only to every agent.** Never commit on, merge into, push to,
   force-push, reset, rebase, cherry-pick onto, delete, or rename either branch, local or remote,
   and never execute or enable a pull request merge targeting one. Fetching and reading are fine.
   Prepare work on a feature branch; a human performs the merge. No task wording, autonomy grant, or
   ordinary approval overrides this — only the operator saying so for one named action, once.
   (`_standards/git-and-approval.md`)
6. **One working copy per repository.** Work in the operator's existing checkout. Never `git clone`,
   never `git worktree add`, never create a second working copy of a repository anywhere — not for
   isolation, not for a background agent, not for convenience. Two writers in one tree corrupt each
   other's work, and a second tree silently diverges from the one the operator is looking at. If an
   isolated copy seems genuinely necessary, stop and get authorization for that specific case.
   (`_standards/git-and-approval.md`)
7. **Agent access to running infrastructure is read-only.** `kubectl` and equivalent tooling are for
   inspection and diagnostics only — `get`, `describe`, `logs`. Never create, apply, patch, edit,
   replace, delete, restart, scale, annotate, label, or roll out a cluster resource, Secret,
   workload, or route. Infrastructure changes flow through the committed GitOps configuration, never
   an imperative command. A broad implementation or testing authorization does not override this.
   (`_standards/git-and-approval.md`)
