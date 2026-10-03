# LimeSpot agent rules — app-ai

Codex reads this file; Claude Code reads `CLAUDE.md` beside it. Both carry the same rules, because a
rule that reaches one agent and not the other is the failure the workspace repository exists to
prevent.

The rules below are inlined rather than referenced. Codex has no include mechanism, so a pointer is
a hint it may skip, while this text is always in context. Codex also stops walking at the nearest
`.git`, which is why these rules live here and not only in the workspace repository above.

Depth lives in the workspace repository's `_standards/*.md`, read on demand — `engineering`,
`testing`, `documentation-and-comments`, `git-and-approval`, `architecture`, `naming`, `security`,
`web-ui`. From inside this repository they resolve at `../_standards/`.

Shared agent skills are canonical in `../.agents/skills/<skill-name>/SKILL.md`, but Codex does not
see that tree from inside this repository, because it stops walking at this repository's `.git`.
The skills reach Codex as copies in `~/.agents/skills/`, placed there by
`../_enforcement/install-agent-skills.sh` — run once per clone and refreshed by the workspace
repository's post-merge hook. Claude Code receives the same skills as the `limespot@limespot`
plugin this repository declares in `.claude/settings.json`, installed once per machine with
`claude plugin install limespot@limespot` and listed as `/limespot:pr-review`,
`/limespot:pr-review-handle`, and `/limespot:pr-finalize`.

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
   A commit message is the one place an issue number belongs, and it sits on line 3 — the subject, a
   blank line, then `Closes <owner>/<repo>#<n>` on the single commit that completes the issue or
   `Related to <owner>/<repo>#<n>` on every other commit that contributes to it, one per line and
   consecutive, before any prose. Nothing else, and issue-less work invents no reference.
   **One issue arrives as exactly one commit.** A review-round fix, or any later pass over the same
   issue, is folded into that commit with `git commit --fixup=<sha>` and an autosquash rebase —
   never stacked as another — and a branch adds at most one issue-less cleanup commit. Only the
   operator, for one named branch, keeps an issue spread across commits.
   (`_standards/documentation-and-comments.md`, `_standards/git-and-approval.md`)
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
6. **Isolate parallel work; one writer per working copy.** Several agent sessions run against these
   repositories at once, so an agent that may run alongside another creates its own worktree —
   `git worktree add ../<repo>-<task> <branch>` — and works there. Sharing the operator's checkout is
   for an agent working alone. Never `git clone` a second copy of a repository already checked out
   here: a worktree shares one object store and one set of refs, a clone silently diverges. Never put
   a worktree on `master`/`main` or on a branch checked out elsewhere, and `git worktree remove` it
   when the task ends — the branch and its commits survive in the main repository.
   (`_standards/git-and-approval.md`)
7. **Agent access to running infrastructure is read-only.** `kubectl` and equivalent tooling are for
   inspection and diagnostics only — `get`, `describe`, `logs`. Never create, apply, patch, edit,
   replace, delete, restart, scale, annotate, label, or roll out a cluster resource, Secret,
   workload, or route. Infrastructure changes flow through the committed GitOps configuration, never
   an imperative command. A broad implementation or testing authorization does not override this.
   (`_standards/git-and-approval.md`)
8. **Code carries no comments.** The one exception is an XML or JSDoc descriptor on a type or a
   public member, and only where the contract is not evident from the name and signature — never
   inside a method body, never a change log, never a restatement of the line below it. Everything
   explanatory belongs in the `CLAUDE.md` files and the `docs/` pages beside them, where a reader
   finds it without reading the code. (`_standards/documentation-and-comments.md`)
9. **Heavy jobs run one per slot, through the gate.** Several sessions share one machine, and a
   test runner, bundler, compiler or container build is heavy enough that a few at once exhaust
   RAM and take the machine down with swap thrash — which no amount of care after the fact undoes.
   So start heavy work as
   `_enforcement/resource-guard/with-resources.sh <label> -- <command>`, which takes one of
   `max(1, min(cores / 4, RAM_GiB / 8))` machine-wide slots first and WAITS when none is free. A
   wait is the gate working: it says why on stderr, and it never refuses. Run
   `_enforcement/resource-guard/with-resources.sh --print-capacity` to see this machine's budget and
   `--status` to see who holds it. Never raise the budget to get your job moving, and never bypass
   the gate with `LIMESPOT_GUARD=off` outside a genuine emergency.
   Caps inside the tools are equally binding, because they are what bounds a runner you invoke
   directly: Jest sets `maxWorkers` and a `globalSetup` run lock, and Playwright sets
   `workers: 1`. For .NET, run `dotnet build -m:N` at a share of the cores, and pass
   `MSBUILDDISABLENODEREUSE=1` on the invocation itself unless you know the environment already
   exports it — MSBuild otherwise leaves its worker nodes alive for about fifteen minutes per
   build, so sequential builds in one session accumulate gigabytes that no concurrency limit would
   ever notice. Never remove or raise one of these caps to make something finish sooner.
   (`_standards/machine-resources.md`)
10. **CI runs the test suites; the local loop is format, lint and build.** Before a push, run the
    repository's formatter check, linter, and build or typecheck over what you touched, plus the
    focused local runs permitted below — never a full suite CI runs. CI runs the suites on the
    pushed head and is their authority: never re-run one locally to confirm or contradict it. A
    repository's `CLAUDE.md` gate list names what its CI enforces, and where it reads as a local
    checklist this rule governs. Focused local runs stay for a reported bug's reproduction test,
    screenshots for a UI change, reproducing a test that failed on exact-head CI, proving a test is
    not vacuous, and a suite CI does not run. That last suite runs at the milestone its repository
    names; until it names one and updates its enforcement in the same change, its existing trigger
    remains authoritative.
    Where no CI runs a repository's suite, it stays local. A pull request merges only on green CI at
    its exact head. (`_standards/testing.md`, "Local gates")
11. **Differential-first when an expensive suite is authorized.** This rule never authorizes a run
    that "Local gates" assigns elsewhere. For an allowed local or protected run, use the smallest
    affected real-path set with no retries; reserve the full protected suite for its named final
    milestone or a separately approved dispatch. Required pull-request CI still runs. Never overlap
    traffic on a shared live target; after an incomplete protected run, restore and verify clean state
    before the next dispatch. Never report focused green as full green. (`_standards/testing.md`,
    "Differential-first validation for expensive suites")
