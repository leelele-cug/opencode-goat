# Contributing

Before opening a change:

- Run `bun install --frozen-lockfile`.
- Run `bun run check`.
- Run `bun run coverage`.
- Run `bun run build` and `bun run pack:smoke`.
- Run `bun run smoke:opencode` when authenticated OpenCode credentials and a
  smoke model are available.
- Keep a compatible OpenCode CLI on `PATH`; the smoke defaults to
  `opencode/deepseek-v4-flash-free` and accepts `OPENCODE_SMOKE_MODEL` for overrides.

Changes that affect lifecycle, workspace attribution, permissions, leases,
Session identity, or schema must include regression tests. Never include
databases, logs, credentials, or private workspace content in a change.
