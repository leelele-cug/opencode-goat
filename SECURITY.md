# Security Policy

Goat orchestrates OpenCode Sessions that can modify a Git workspace. Treat it
as workflow control, not as an operating-system sandbox.

## Safe Use

- Run Goat only in repositories and worktrees you trust.
- Keep OpenCode permissions for external directories and side-effecting tools at
  `ask` or `deny`.
- Protect `OPENCODE_GOAT_HOME`; it contains source requests, Contracts,
  evidence references, audit records, and workspace patches.
- Do not share a Goat database between unrelated OS users or projects.

## Reporting

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
private vulnerability reporting for this repository:
<https://github.com/leelele-cug/opencode-goat/security/advisories/new>.
Include the package version, OpenCode version, platform, reproduction steps,
and whether sensitive data was involved.

Supported hosts must satisfy the `engines.opencode` range declared in
`package.json`. The OpenCode plugin and SDK dependencies remain exact release
build pins. Database schema changes are intentionally incompatible unless the
release notes state otherwise.
