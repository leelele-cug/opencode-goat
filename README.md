# Goat

English | [简体中文](README.zh-CN.md)

![GOAT: Better Goal for OpenCode](assets/readme/hero.svg)

Goat adds an explicit, independently checked Goal workflow to OpenCode.

This release is an alpha preview. Use it first with a trusted repository and a
disposable Goal while you review the resulting changes and your OpenCode
permissions.

Source and issue tracker: <https://github.com/leelele-cug/opencode-goat>

The workflow turns `/goat <intent>` into a clear plan, waits for your approval,
works in an isolated native Git worktree, and independently checks the result
before marking the Goal done.

## Requirements

- OpenCode `>=1.18.15`
- Git `2.40+`
- A clean source Git repository before each Goal: no staged, unstaged, or untracked changes
- A separate native Git worktree for each Goal; do not use the source directory as the execution workspace

## Install

Add `opencode-goat` to your OpenCode plugin configuration:

```json
{
  "plugin": ["opencode-goat@alpha"]
}
```

The plugin needs no additional configuration. `OPENCODE_GOAT_HOME` may override
the local data directory; by default Goat uses the platform data location plus
`opencode-goat`.

The package is published under the `alpha` dist-tag. Review the changelog and
pin an exact release when you need a reproducible preview setup.

## Commands

```text
/goat <intent>        start a Goal from a desired outcome
/goat                 show a concise status
/goat status          show the plan, checks, results, and history
/goat pause           pause and keep the worktree changes
/goat resume          continue after a pause or blocked check
/goat revise <change> return to planning with a requested change
/goat cancel          cancel and keep all worktree changes
/goat doctor          inspect the current project and worktree
/goat help            show short usage help
```

## Workflow

![Goat Goal workflow](assets/readme/workflow.svg)

1. **Goal**: Describe the outcome you want with `/goat <intent>`.
2. **Plan**: Goat turns the request into a concrete scope, constraints, and checks.
3. **Approve**: Review and approve the plan before any worktree changes begin.
4. **Execute**: After approval, Goat creates an isolated native Git worktree and makes changes only there.
5. **Verify**: A separate Verifier checks the approved criteria and evidence in the same worktree; failed checks return findings for correction.
6. **Done**: The Goal is complete only after verification passes.

A failed initial verification can trigger at most ten automatic corrections per
batch; the initial verification is not a correction. When that limit is
reached, use `/goat resume` to continue with another batch. No worktree changes
are discarded by the correction loop.

## Safety

- Goat is workflow control, not an OS sandbox. OpenCode's native permissions are the final authority.
- Keep OpenCode permissions for external directories and other side-effecting tools at `ask` or `deny` unless you have reviewed the risk.
- Protect the local Goat data directory. It contains Goal requests, plans, check results, history, and workspace references; do not share it between unrelated users or projects.
- Review changes in the worktree yourself before committing, merging, or pushing.
- Goat keeps the native worktree after completion, cancellation, or revision. It never commits, merges, pushes, or removes it automatically.

See [SECURITY.md](SECURITY.md) for the user security guide.

## Contributing

Development and release commands, maintainer guidance, and internal terminology
are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
