# Changelog

## 0.1.0-alpha.3 - 2026-08-14

- Refined the public README, workflow visuals, and social preview around the
  explicit Goal-to-Verification flow.
- Kept internal development notes out of public repository and package
  documentation.
- Consolidated maintainer release guidance into `CONTRIBUTING.md`.

## 0.1.0-alpha.2 - 2026-08-09

- Schema v8 and ten-round verification batches.
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
- Database Schema v6 is incompatible with earlier Goat schemas.
