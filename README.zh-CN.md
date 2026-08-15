# Goat

[English](README.md) | 简体中文

![GOAT：Better Goal for OpenCode](assets/readme/hero.svg)

Goat 为 OpenCode 提供一套明确、带独立检查的 Goal 工作流。

这是 alpha 预览版本。请先在可信的仓库和可丢弃的 Goal 中使用，并检查产生的
修改以及你的 OpenCode 权限设置。

源码与 issue：<https://github.com/leelele-cug/opencode-goat>

工作流会将 `/goat <意图>` 形成清晰计划，等待用户批准，在隔离的 native Git
worktree 中执行，并在将 Goal 标记为完成前独立检查结果。

## 要求

- OpenCode `>=1.18.15`
- Git `2.40+`
- 每个 Goal 开始前都必须有干净的源 Git 仓库：没有暂存、未暂存或未跟踪的修改
- 每个 Goal 使用独立的 native Git worktree；不能把源目录作为执行 workspace

## 安装

在 OpenCode 插件配置中加入：

```json
{
  "plugin": ["opencode-goat@alpha"]
}
```

插件无需额外配置。可使用 `OPENCODE_GOAT_HOME` 覆盖本地数据目录；默认目录为平台
数据目录下的 `opencode-goat`。

当前预览包使用 `alpha` dist-tag。需要可复现的预览环境时，请先阅读 CHANGELOG
并固定使用具体版本。

## 命令

```text
/goat <意图>          从期望结果开始一个 Goal
/goat                 显示简要状态
/goat status          显示计划、检查、结果和历史
/goat pause           暂停并保留 worktree 修改
/goat resume          在暂停或检查阻断后继续
/goat revise <修改>   带着修改要求返回计划阶段
/goat cancel          取消并保留全部 worktree 修改
/goat doctor          检查当前项目和 worktree
/goat help            显示简短帮助
```

## 工作流程

![Goat Goal 工作流](assets/readme/workflow.zh-CN.svg)

1. **Goal**：使用 `/goat <意图>` 描述期望结果。
2. **计划**：Goat 将请求整理为明确的范围、约束和检查项。
3. **批准**：在任何 worktree 修改开始前，检查并批准计划。
4. **执行**：批准后，Goat 创建隔离的 native Git worktree，并且只在其中完成修改。
5. **验证**：独立 Verifier 在同一 worktree 中检查已批准的标准与证据；失败时返回问题要求修正。
6. **完成**：验证通过后，Goal 才会完成。

初次验证失败后，每批最多进行十次自动修正；初次验证本身不计为修正。达到上限后，
使用 `/goat resume` 开启下一批继续；修正循环不会丢弃 worktree 修改。

## 安全

- Goat 是工作流控制，不是 OS sandbox。OpenCode 原生权限始终是最终控制层。
- 对外部目录和其他有副作用的工具，除非已审查风险，否则请将 OpenCode 权限保持为 `ask` 或 `deny`。
- 请保护本地 Goat 数据目录。它包含 Goal 请求、计划、检查结果、历史和 workspace 引用；不要在无关用户或项目之间共享。
- 在 commit、merge 或 push 前，请自行检查 worktree 中的修改。
- Goat 会在完成、取消或修订后保留 native worktree；不会自动 commit、merge、push 或删除它。

参见 [SECURITY.md](SECURITY.md) 用户安全指南。

## 贡献

开发与发布命令、维护者指南和内部术语见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
