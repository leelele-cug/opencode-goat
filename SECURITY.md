# Security Guide

Goat controls an OpenCode workflow that can modify files in a Git worktree. It
is workflow control, not an operating-system sandbox.

## Before You Start

- Use Goat only with a source Git repository and worktree you trust.
- Start each Goal from a clean source repository and use a separate native Git
  worktree for execution.
- Treat the alpha release as experimental. Review the plan, permissions, and
  resulting worktree changes before using them elsewhere.

## Permissions

OpenCode's native permission system is the final authority. Goat does not
replace it or make an OS-level security boundary. Keep permissions for external
directories and other side-effecting tools at `ask` or `deny` unless you have
reviewed the specific operation and its consequences.

Do not use Goat as the only control for access to credentials, destructive
commands, network services, or data outside the approved worktree.

## Local Data

Protect `OPENCODE_GOAT_HOME`, or the platform data directory used when that
variable is not set. Goat stores Goal requests, plans, check results, history,
and workspace references there.

- Restrict access to the local data directory to the users who need it.
- Do not share one data directory between unrelated users or projects.
- Keep credentials and other secrets out of Goal requests and generated logs.
- Include the directory in backups only when its contents are appropriate for that backup.

## Worktrees

Goat preserves the native worktree after completion, cancellation, and revision.
It never commits, merges, pushes, or removes a worktree automatically. Review
the worktree and perform any cleanup or Git operation explicitly.

## Private Vulnerability Reporting

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
private vulnerability reporting for this repository:
<https://github.com/leelele-cug/opencode-goat/security/advisories/new>.

Include the Goat version, OpenCode version, platform, reproduction steps, and
whether sensitive data was involved. Remove secrets from the report and use a
private channel for any necessary sensitive attachment.
