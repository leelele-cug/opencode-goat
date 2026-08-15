# Contributing

README.md and README.zh-CN.md are user-facing documents. Maintainer commands,
release procedures, and implementation terminology belong here.

## Development

Use Bun `1.3.14` and a compatible OpenCode CLI. Before opening a change:

```text
bun install --frozen-lockfile
bun run check
bun test
bun run coverage
bun run coverage:check
bun run build
bun run pack:smoke
bun run smoke:opencode
```

`bun run check` performs typechecking and tests. `bun run coverage` runs the
coverage suite, while `bun run coverage:check` enforces the coverage gate.
`bun run smoke:opencode` requires authenticated OpenCode credentials and a
smoke model; it defaults to `opencode/deepseek-v4-flash-free` and accepts
`OPENCODE_SMOKE_MODEL` for an override.

## Internal Vocabulary

- **Goal**: the durable user request and its lifecycle.
- **Plan**: the user-facing formulation of outcome, scope, constraints, assumptions, and checks.
- **Contract**: the canonical internal form of an approved plan.
- **Contract revision**: one immutable proposed version of a Contract; approval is tied to this version.
- **Run**: the durable execution record for an approved Contract revision; it
  stores worktree, Session, finalization, and remediation facts but owns no
  lifecycle state.
- **Formulator, Executor, and Verifier Sessions**: the fixed internal roles used to formulate, execute, and independently check a Run.
- **Preflight**: the clean-workspace and Git-state check performed before a Run is activated.
- **Lease**: the persisted ownership guard that prevents competing Goat processes from advancing one Goal at the same time.
- **Dispatch**: a persisted request to deliver work to a specific child Session.
- **Fencing**: the token check that rejects stale process or Session ownership.
- **Workspace snapshot**: the canonical Git-visible HEAD, status, diff, and untracked-file evidence captured at a workflow boundary.
- **Schema reset**: the deliberate replacement of the local persistence format when the approved internal model changes; no migration layer is maintained.

## Lifecycle and Handoffs

`goals.state` is the sole authoritative workflow state and has exactly these
values:

```text
PLANNING
AWAITING_APPROVAL
PREPARING
EXECUTING
FINALIZING_EXECUTION
VERIFYING
FINALIZING_VERIFICATION
PAUSED
BLOCKED
COMPLETED
CANCELLED
```

Do not add `runs.state`, infer lifecycle from dispatch or Session status, or
grant role authority in a second record. Executor authority exists only in
`EXECUTING`; Verifier authority exists only in `VERIFYING`. Preparation and all
work happen in a native Git worktree created only after approval. The source
checkout is never an execution fallback.

The completion and verifier-report tools validate and persist their payload,
then return immediately. They must not wait for Session idle, poll for a state
change, or interrupt their Session. The corresponding Session idle event starts
the fenced handoff into `FINALIZING_EXECUTION` or
`FINALIZING_VERIFICATION`. Idle without a matching durable proposal/report does
not advance the Goal.

Pause first stores the phase route in `resume_state`, changes the Goal to
`PAUSED`, and revokes role authority. Checkpointing and any Session interruption
happen only afterward. Resume reads `resume_state` and invokes phase-specific
recovery; it never guesses a generic active phase.

The initial verification is remediation round 0 and is not a correction. A
batch permits up to ten remediation rounds, each consisting of one Executor
correction and a fresh independent verification. A non-pass after remediation
round 10 blocks until `/goat resume` explicitly starts another batch.

Schema v9 is a reset with no migration. An incompatible database must be moved
aside or removed before Goat creates a new v9 database. Goat never
automatically commits, merges, pushes, or deletes preserved worktrees.

Keep these terms in maintainer and implementation documentation rather than in
the user README. Changes that affect lifecycle, workspace isolation,
permissions, leases, Session identity, or schema must include regression tests.
Never include databases, logs, credentials, or private workspace content in a
change.

## Releasing

- Update `package.json` and `CHANGELOG.md` together. The package version,
  changelog version, and release tag must agree. Update public README content or
  visual assets only when user-visible behavior or presentation changes.
- Keep internal development notes in maintainer documentation, not in the user README or SECURITY.md.

Every release is blocked until all gates pass:

- Start from a clean tree and use a frozen dependency install.
- Pass `bun run check`, `bun run coverage:check`, and `bun run build` on Ubuntu,
  Windows, and macOS.
- Pack one candidate tarball and pass `bun run pack:smoke` against that exact
  candidate.
- Pass package-root OpenCode load and an authenticated native-worktree workflow
  smoke against both the minimum supported OpenCode CLI and `latest`, using the
  same candidate package.
- Confirm npm OIDC Trusted Publishing and provenance are enabled; do not use a
  long-lived npm publication token.

Do not publish when any gate is skipped, unavailable, or failing. Create and
push the matching tag `v<package.version>` only for the gated candidate.
Prereleases use the matching `alpha`, `beta`, or `rc` dist-tag; reserve `latest`
for stable releases. After publication, verify the npm version, integrity,
package files, `./server` export, provenance, and dist-tag before announcing the
release.
