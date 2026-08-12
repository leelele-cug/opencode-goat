# Visual Assets

## Core idea

Goat is an evidence loop, not a linear automation pipeline:

```text
authority out:  intent -> Contract -> human approval -> scoped execution
evidence back: diff -> independent verification -> pass, fix, or block
```

The forward path is lime because it represents approved authority. The return
path is cyan because it represents evidence and independent inspection. Orange
is reserved for the human approval gate and correction or blocked states. The
graphite and warm-white base keeps the material closer to an engineering
instrument than a generic AI illustration.

## Asset map

- `brand/goat-mark.svg`: compact evidence-loop mark for avatars and headers.
- `brand/goat-wordmark.svg`: mark, wordmark, and the authority/evidence message.
- `readme/hero.svg`: English README hero with the complete loop.
- `readme/hero.zh-CN.svg`: Chinese README hero with the same geometry.
- `readme/workflow.svg`: English workflow with the approval gate and correction loop.
- `readme/workflow.zh-CN.svg`: Chinese version of the workflow.
- `social/github-social-preview.svg`: editable 1280x640 social-preview source.
- `social/github-social-preview.png`: raster upload candidate generated from the SVG.

## Rules

- Every node must correspond to a real Goat behavior: Contract, approval, workspace execution, evidence, verification, completion, correction, or block.
- The approval gate must remain visible in every summary workflow.
- A verification failure must return to execution; never draw the product as a one-way pipeline.
- Do not imply that Goat is an OS sandbox or that it commits, merges, pushes, or deletes worktrees automatically.
- Keep SVGs self-contained. Do not add remote images, scripts, tracking pixels, or external font URLs.
- Keep text large enough to survive README scaling; decorative labels are less important than the main flow.
- Keep English and Chinese compositions semantically identical, even when line breaks differ.
- Do not add product screenshots unless they come from a real authenticated smoke run.
