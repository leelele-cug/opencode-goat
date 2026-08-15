# Changelog

## 0.1.0-alpha.5 - 2026-08-15

- Clarified the supported setup: a clean source Git repository and an independent native Git worktree for every Goal.
- Made the user workflow explicit: Goal -> Plan -> Approve -> Execute -> Verify -> Done.
- Limited remediation to ten rounds per batch; the initial verification is not
  a correction, and `/goat resume` starts another batch when needed.
- Made `goals.state` the sole lifecycle authority with
  `PLANNING/AWAITING_APPROVAL/PREPARING/EXECUTING/FINALIZING_EXECUTION/VERIFYING/FINALIZING_VERIFICATION/PAUSED/BLOCKED/COMPLETED/CANCELLED`;
  there is no `runs.state`.
- Restricted role authority to `EXECUTING` and `VERIFYING`, and made
  completion/report handoffs run from Session idle events after their tools
  return without waiting or interrupting.
- Made pause revoke role authority before checkpointing and made resume route
  from the persisted `resume_state`.
- Schema v9 now stores pause/resume context, verification snapshots, finalization
  operation keys, and terminal run reasons. Existing Goat databases must be
  moved aside and recreated; no migration is provided for this alpha.
- Preserved worktrees for user review and removed automatic commit, merge, push, and worktree removal behavior from the user workflow.
- Clarified that OpenCode permissions remain the final authority and that Goat is not an OS sandbox.
- Added user guidance for protecting Goat's local data directory.
- Documented private vulnerability reporting and mandatory release gates.
- Aligned the authenticated release smoke with the bounded remediation loop so
  a valid correction round is exercised instead of being treated as a harness
  failure.

## 0.1.0-alpha.3 - 2026-08-14

- Refined the public README, workflow visuals, and social preview around the
  explicit Goal-to-Verification flow.
- Kept internal development notes out of public repository and package
  documentation.
- Consolidated maintainer release guidance into `CONTRIBUTING.md`.

## 0.1.0-alpha.2 - 2026-08-09

- Improved Goal persistence and ten-round verification batches.
- OpenCode CLI compatibility starts at `>=1.18.15`; plugin and SDK build pins remain `1.18.15`.
- Authenticated smoke defaults to `opencode/deepseek-v4-flash-free` without changing user Goal models.
- Root and native-worktree plugin instances now share one project-scoped lease owner.
- Executor and Verifier idle/error Sessions now terminate stuck Runs explicitly.
- Authenticated smoke diagnostics fail fast and preserve failed artifacts.
- Run finalization now closes the Executor write window before verification.
- Contract criteria use explicit inspection or exact command verification steps.
- Executor native bash access remains governed by OpenCode permissions.
- Cancelled and revised worktrees are preserved for explicit user cleanup.
- Cross-platform path fixtures and reserved-agent lifecycle checks were
  hardened.
- README and social visuals now use an evidence-loop system that shows the
  approval gate, returned evidence, independent verification, and correction.

## 0.1.0-alpha.1

- Initial public-preview release.
- Durable Goal Contracts, approval generations, Executor Sessions, Verifier
  Sessions, workspace attribution, leases, recovery, and SQLite persistence.
- OpenCode `1.18.11` and Bun `1.3.14` were pinned for the alpha.1 release.
