# Goat for OpenCode: Design and Implementation Plan

**Goat** stands for **Goal Operationalization, Alignment & Testing**.

## Document Status

| Item | Value |
| --- | --- |
| Status | Approved normative target design; implementation conformance is validated separately |
| Plugin ID | `goat` |
| Package | `opencode-goat` |
| Command | `/goat` |
| OpenCode target | Latest stable release; current verified baseline `1.18.11` |
| Compatibility | No backward compatibility with prior Goat schemas or APIs |
| Persistence | External SQLite database |
| Approval UI | OpenCode native Question |
| Agents | Formulator, Executor, independent Verifier |
| Workspaces | Current workspace or native Git worktree |
| Idle behavior | Non-authoritative; never triggers continuation or completion |
| Verification retries | At most seven automatic attempts per Run |

## 1. Product Objective

`/goat` turns an incomplete user intent into an approved, durable, and verifiable execution workflow:

```text
intent
  -> read-only discovery and native Questions
  -> immutable Goal Contract proposal
  -> exact user approval
  -> execution in an approved workspace
  -> evidence collection
  -> independent verification
  -> completion, correction, or explicit blockage
```

The implementation is complete only when this path works through real OpenCode hooks and SDK calls. Isolated domain or Store tests are not a substitute for the production call graph.

Goat MUST:

- Research repository and documentation facts before asking avoidable questions.
- Ask only decisions the user is qualified to make.
- Require approval of an exact Contract revision before project writes.
- Keep user permission rules authoritative.
- Persist every Goat approval, state transition, dispatch, and verification outcome.
- Recover safely from interruption and restart.
- Require evidence and an independent Verifier for every MUST criterion.

Goat MUST NOT:

- Infer approval from model text.
- Modify the target workspace before approval.
- Replace OpenCode's native permission system with a second permission engine.
- Silently change scope, constraints, criteria, or workspace strategy.
- Silently fall back from an approved worktree to the current workspace.
- Report completion from Executor confidence or prose.
- Add compatibility branches for old Goat implementations.

## 2. Design Principles

### 2.1 Contract Before Authority

No persistent target-project write is permitted before an exact Contract revision is approved.

### 2.2 SQLite Is Authoritative

Prompts, tool output, status cards, and compaction context are projections. They never replace persisted state.

### 2.3 Reuse OpenCode

Goat uses native Question, permission, worktree, Session, TUI, and event APIs. It implements only Goal-specific behavior that OpenCode does not provide.

### 2.4 Explicit Transitions

State changes use named Store operations. There is no externally callable generic workflow or arbitrary `from -> to` transition API.

### 2.5 Durable Before External

External work begins only after a durable intent is committed. Stable message IDs reconcile uncertain prompt delivery.

### 2.6 Simple but Not Simplistic

The design keeps meaningful domain boundaries, relational integrity, lease fencing, and crash recovery. It removes generic workflow frameworks, duplicate permission models, capability grants, durable Decision Cards, general child-task systems, and idle continuation schedulers.

## 3. OpenCode Boundary

The current implementation target is OpenCode `1.18.11`. Before implementation and before release, verify the latest stable release and the registry versions of `@opencode-ai/plugin` and `@opencode-ai/sdk`. Pin verified versions exactly; never use a floating runtime dependency.

Required public capabilities:

| Capability | Use |
| --- | --- |
| Plugin/config hooks | Register `/goat`, agents, and tools |
| Command hook | Apply `/goat` controls deterministically |
| `tool.execute.before` | Enforce lifecycle and bind approval Questions |
| `tool.execute.after` | Resolve approval answers |
| Native Question | Ordinary clarification, Contract approval, and pending-Question reconciliation |
| Native permission | Final tool policy after Goat role/lifecycle checks |
| Session SDK | Directory-scoped Session reads, stable prompt dispatch, and message reconciliation |
| Native worktree API | List, create, observe readiness, reuse, and safely remove isolated Git worktrees |
| Session events | Observe prompt lifecycle; never infer completion or continuation |
| Session message lookup | Reconcile delivery by stable message ID |
| Session diff | Verifier change inspection |
| TUI toast | Sparse, actionable background notifications |
| Compaction hook | Preserve minimal durable Goal context |

Rules:

- Use official `1.18.11` types rather than handwritten hook or SDK shapes.
- Reuse the plugin-injected client and its transport/authentication context for supported APIs. A separately constructed V2 client is permitted only for V2-only capabilities and MUST preserve the same authenticated transport semantics.
- Every Session, message, diff, Question, VCS, and worktree operation carries the persisted project or Run directory explicitly; adapters never silently substitute the startup directory.
- Critical transitions occur in awaited command or tool hooks.
- Generic events only enqueue reconciliation; processing always reloads Store state.
- Ordinary Question events are observational. Contract approval is committed from the awaited Question after-hook.
- Do not modify or replace user message parts.
- Do not depend on undocumented system-prompt transformation behavior.
- Do not import OpenCode internal services.
- The startup compatibility check covers every API Goat actually invokes. Release compatibility is established by a real authenticated OpenCode load and workflow smoke, not by property-existence checks alone.

Goat's enforcement claim is limited to tool calls observed by its awaited before-hook and the OpenCode permission system. It does not claim control over side effects outside that envelope.

## 4. Architecture

The implementation has six practical modules plus one composition root. Supporting files such as Ports, adapters, data-home handling, deferred recovery, and command parsing remain inside these boundaries rather than becoming new services.

| Module | Responsibility |
| --- | --- |
| Core | State, Contract, Question mapping, evidence rules, lifecycle guard |
| Store | Schema, reads, and all authoritative transactions |
| Runtime | Approval activation, workspace, dispatch, verification, recovery |
| OpenCode | SDK adapter, hooks, commands, agents, prompts |
| Tools | Six thin model-facing operations |
| Presentation | Pure status, approval, blocker, and completion rendering |
| `index.ts` | Startup, dependency construction, registration, disposal |

Dependency direction:

```text
OpenCode hooks/commands/tools -> Runtime -> Store -> Core
OpenCode adapter ----------------^       ^
Presentation --------------------------> Core/read models
index.ts constructs and disposes all dependencies
```

Core has no OpenCode, SQLite, network, or filesystem imports. Store imports Core but never OpenCode. Runtime coordinates Store with a small OpenCode gateway. OpenCode-specific types remain at the edge.

Only two main stateful objects are needed:

- `Store`: the persistence facade and sole mutation authority.
- `Orchestrator`: the external workflow coordinator.

A small in-memory per-Goal serialization queue may prevent same-instance hook races. It is an implementation helper, not a durable service: every action reloads Store state, checks the current lease, and remains correct after process loss.

Do not add a public Repository layer, dependency injection framework, generic service container, Scheduler service, or workflow engine.

## 5. Agents

Three distinct roles are retained because their responsibilities, Session lifecycles, and permissions are materially different.

| Agent | Responsibility | Restrictions |
| --- | --- | --- |
| `goat-formulator` | Discovery, clarification, Contract drafting | Root Session; read-only except native Questions; no edit, arbitrary shell, or child tasks |
| `goat-executor` | Execute the approved Contract | One dedicated child Session per Run; role and workspace bound; writes only after approval |
| `goat-verifier` | Independently verify every criterion | One hidden child Session per verification attempt; read-only and Run-directory bound |

The originating root Session hosts `goat-formulator`. After workspace activation, each Run owns one persisted `goat-executor` child Session created under that root Session and in the exact Run directory. Initial, remediation, and resume dispatches all target that child Session. Each verification attempt owns a new `goat-verifier` child Session. These are fixed Goat workflow Sessions, not general model-created child tasks.

When `/goat <intent>` starts, Goat captures the root Session provider, model ID, and variant when available. Approval copies the selection to the Run; Executor and Verifier child Sessions use the persisted Run model. Prompt delivery never silently reselects a provider, model, or variant. A missing model is an explicit compatibility or configuration failure, not an invitation to use a different model.

The Executor has a focused Goat prompt and a Goat-authored Session permission envelope describing the workflow ceiling: read/search tools and approved workspace file writes are available only after the lifecycle guard permits the call; shell execution, `task`, and native `question` are denied in the Executor child. OpenCode's native permission resolver remains the final policy layer. Goat MUST never append a rule that broadens a user `deny` or changes a user `ask` into an unconditional allow. Integration tests MUST prove that user `allow`, `ask`, and `deny` rules remain effective.

The Formulator and Verifier use explicit restrictive agent and Session permissions. Their configuration merges with existing user rules and only adds stricter denies, except that the Formulator must retain native Question access for ordinary clarification and Contract approval. Goat MUST never replace a scalar deny, discard an existing rule, or add an `allow` rule that overrides a user deny.

The deterministic Orchestrator is not a fourth model role.

## 6. Lifecycle

States:

```text
FORMING
AWAITING_APPROVAL
ACTIVE
VERIFYING
PAUSED
BLOCKED
COMPLETED
CANCELLED
FAILED
```

Primary transitions:

```text
FORMING -> AWAITING_APPROVAL
AWAITING_APPROVAL -> ACTIVE
AWAITING_APPROVAL -> FORMING
AWAITING_APPROVAL -> BLOCKED
ACTIVE -> VERIFYING
ACTIVE -> PAUSED
ACTIVE -> BLOCKED
VERIFYING -> COMPLETED
VERIFYING -> ACTIVE
VERIFYING -> BLOCKED
PAUSED -> ACTIVE
BLOCKED -> ACTIVE
ACTIVE | VERIFYING | PAUSED | BLOCKED -> FORMING  (revision)
any non-terminal -> CANCELLED | FAILED
```

Terminal states are absorbing. `REVISION_REQUIRED` is removed: a revision request closes the current Run, invalidates pending approval or dispatch work, and returns the Goal to `FORMING`.

Approval does not move the Goal directly to `ACTIVE`. It creates a preparing Run while the Goal remains `AWAITING_APPROVAL`; only successful workspace preparation and baseline persistence perform `AWAITING_APPROVAL -> ACTIVE`. Preparation failure atomically blocks both the Run and Goal.

Invariants:

```text
state before ACTIVE
=> no target-project persistent write

ACTIVE or VERIFYING
=> an exact approved revision and Run workspace are bound

runtime mutation or external Goat dispatch
=> the current instance owns an unexpired lease and fencing token

material Goal change
=> a new immutable revision and approval

COMPLETED
=> every MUST criterion has evidence and an independent passing finding
```

## 7. Goal Contract

A Contract revision is an immutable aggregate, not a polished prompt.

Contract body:

```typescript
interface ContractBody {
  sourceRequest: string
  outcome: string
  scope: {
    included: string[]
    excluded: string[]
  }
  constraints: string[]
  assumptions: string[]
  workspace: "current" | "worktree"
}
```

Acceptance criterion:

```typescript
interface AcceptanceCriterion {
  id: string
  priority: "must" | "should"
  description: string
  verificationMethod: string
}
```

Rules:

- `sourceRequest` comes from the persisted `/goat <intent>` and is not model-editable.
- The original `sourceRequest` remains immutable. `/goat revise <change>` persists the exact change separately as a durable `formation_request`; it never rewrites the original request.
- Contract permissions and capability lists do not exist.
- Criteria are relational rows, not duplicated inside Contract JSON.
- The revision hash is computed over canonical Contract body plus criteria sorted by stable ID.
- Contract body and criteria become immutable in one proposal transaction.
- Corrections create a new revision.
- Only one revision may await approval for a Goal.

`formation_request` is cleared only when the replacement Contract proposal commits. The Formulator receives both the original request and the pending formation request through `goat_state`, including after compaction or restart.

Ready Gate:

- Outcome is observable.
- Included and excluded scope are explicit.
- Material constraints and assumptions are disclosed.
- At least one MUST criterion exists.
- Every criterion has a stable unique ID and feasible verification method.
- Outcome-changing questions are resolved.
- Workspace strategy is explicit and available for the project.

A failed Ready Gate returns actionable gaps and does not insert a revision.

## 8. Questions and Approval

### 8.1 Ordinary Decisions

The Formulator uses OpenCode's native Question directly. `goat_decision_prepare`, durable Decision Cards, decision tables, and response-type engines do not exist.

Important answers are incorporated into the Contract. The approved Contract is the durable authority; the Session transcript preserves the discussion.

### 8.2 Contract Approval

Only Contract approval uses Goat-owned durable Question binding.

```text
goat_contract_propose
  -> schema and Ready Gate
  -> immutable revision, criteria, and hash
  -> contract_approval row
  -> deterministic concise approval summary
  -> native Question
  -> before-hook binds real Session, call, and request identity when observable
  -> after-hook maps exact labels to stored option IDs
  -> Store resolves approval atomically
```

The native payload uses the official current OpenCode Question type and shape `{ questions: [...] }`. Internal IDs never come from the model. Normal tool output and approval presentation do not expose approval IDs, revision hashes, call IDs, request IDs, fencing tokens, or dispatch IDs.

Approval choices:

```text
Approve and start
Revise
Cancel
```

Effects:

- Approve: mark the revision approved and create a preparing Run plus pending executor dispatch.
- Revise: reject the proposal and return the Goal to `FORMING`.
- Cancel: consume the approval and move the Goal to `CANCELLED`.

An approval binds Goal, revision, hash, root Session, native Question request when available, Question call, canonical payload, stable option mapping, expiry, and answer. Any revision change invalidates pending approvals.

On restart, query current native Question state and classify each pending approval:

- A matching live Question preserves or repairs its binding.
- A missing Question clears only native request/call binding and creates a stable approval-reissue dispatch for the same immutable revision.
- An expired live Question is rejected before the same immutable revision is reissued with a refreshed expiry.
- A dismissed or rejected Question is reconciled explicitly; it is never left bound until timeout by accident.

Reissue never creates another Contract revision or approval row. Nested answers, cardinality, labels, Session, call, request identity, expiry, and replay are validated before resolution.

## 9. Permission and Lifecycle Guard

Goat does not implement Contract permissions, semantic action classification, temporary capability grants, or a second permission UI. It does implement a structural role/lifecycle guard. The guard is a workflow ceiling; OpenCode's native permission resolver remains the final tool-level policy and user rules remain authoritative.

Goat does not copy or map any native Agent permission baseline. The three Goat agents are fixed: `goat-formulator` (primary, root Session), `goat-executor` (primary, child Session per Run), and `goat-verifier` (subagent, child Session per attempt). Their capabilities are defined once in `src/core/role-capabilities.ts` and used to generate Agent tool visibility and lifecycle guards. Goat never generates `allow` or `ask` permission rules and never overrides an existing `goat-*` agent definition; a user-defined reserved Agent ID fails startup. OpenCode\x27s native permission resolver remains the final tool-level policy and user rules remain authoritative.

The positive generic-tool allowlists are:

```text
Formulator/root before approval:
  read, glob, grep, list, lsp, webfetch, websearch, question

Verifier while VERIFYING:
  read, glob, grep, list, lsp, webfetch, websearch

Executor while ACTIVE:
  read, glob, grep, list, lsp, webfetch, websearch,
  edit, write, bash, apply_patch
```

The Executor child Session adds only `task` and `question` denies. The Verifier Session adds only `edit`, `write`, `bash`, `apply_patch`, `task`, and `question` denies. The Formulator may use native `question` but never receives write, arbitrary shell, or child-task access. Native permission evaluation applies after these structural checks and may further restrict any call.

Structural rules enforced by the before-hook:

- Sessions without an active Goat Goal are untouched.
- Before approval, the root/Formulator Session permits only the known read set and native Question.
- Before approval, writes, arbitrary shell, unknown custom tools, unknown MCP tools, task tools, and external side effects fail closed.
- `PAUSED`, `BLOCKED`, and `VERIFYING` prevent Executor writes.
- The Verifier Session is always read-only.
- Executor and Verifier calls use their persisted Run directory; generic tools execute through directory-scoped child Sessions.
- Exact registered Goat tools bypass only the generic tool guard and still perform role, state, Session binding, lease, and workspace validation internally.

The exact internal tool set is:

```text
goat_state
goat_contract_propose
goat_evidence_record
goat_completion_propose
goat_block
goat_verifier_report
```

Prefix matching such as `startsWith("goat_")` is forbidden. Unknown `goat_*`, custom, MCP, task, and future tools follow the same fail-closed lifecycle rules as every other unknown tool.

Pre-approval, `PAUSED`, `BLOCKED`, and `VERIFYING` use positive allowlists appropriate to the role and state. Every Goat mutation additionally validates the exact configured agent, root, Executor, or Verifier Session binding, current Goal/Run state, live lease ownership, and normalized `context.directory`/`context.worktree` against the persisted Run workspace. Mutating commands require the true root Session or the exact bound role Session as specified by the tool; unrelated child Sessions cannot create or control Goals.

After the structural guard, OpenCode's native permission system decides tool-level `allow`, `ask`, `deny`, command patterns, external directory access, and user overrides. User `deny` remains final; Goat's Session rules cannot broaden it. Goat never creates a second permission prompt or infers permission from model prose.

Contract scope and constraints are execution instructions and independent verification targets. They are not duplicated as a second low-level permission language.

The following prior concepts are removed:

```text
Contract allow/approval-required/deny tool lists
capability challenges
one-time grants
argument grant replay
semantic action taxonomy
child capability subsets
```

## 10. Persistence

Goat uses Bun SQLite with WAL, foreign keys, explicit `BEGIN IMMEDIATE` transactions, and exactly schema v6. `PRAGMA user_version = 6` identifies the supported schema. There is no migration chain or `schema_migrations` table. Schema v1-v5, any other version, an unversioned non-empty database, and shape-drifted v6 databases fail startup without modification.

An incompatible database fails startup with an actionable message. Goat does not silently delete user files or execute compatibility migrations.

### 10.1 Tables

| Table | Purpose |
| --- | --- |
| `goals` | Immutable source request, durable formation request, root Session, originating project directory/worktree, pinned provider/model/variant, current state, approved revision |
| `contract_revisions` | Immutable Contract body and aggregate hash |
| `approval_attempts` | Immutable approval generations: canonical native Question payload, request/call binding, answer, expiry, status, preflight snapshot |
| `acceptance_criteria` | Stable criteria belonging to a revision |
| `runs` | Approved execution, stable worktree identity, workspace, baseline, pinned model, bound Executor Session, status, verification budget and post-limit authorization |
| `dispatches` | Durable approval, Executor, and Verifier prompt outbox with stable `msg_*` identity, target binding, payload, hash, and delivery status |
| `evidence` | Immutable criterion evidence |
| `verification_results` | Per-attempt findings and derived outcome |
| `session_bindings` | Active and revoked Executor/Verifier Session identities |
| `leases` | Goal owner, expiry, monotonic fencing token |
| `audit_events` | Append-only critical history |

### 10.2 Relationships

```text
Goal
  -> Contract Revisions
      -> Contract Approvals
      -> Acceptance Criteria
          -> Evidence
  -> Runs
      -> Verification Results
  -> Dispatches (optionally bound to a Run)
  -> Lease
  -> Audit Events
```

### 10.3 Integrity

- One non-terminal Goal per root Session.
- One pending Contract revision per Goal.
- One active Run per Goal.
- Criterion ID unique within a revision.
- Evidence references a criterion from the Run's approved revision.
- Redundant Goal, Run, revision, criterion, approval hash, and root Session identities are protected by composite candidate keys and foreign keys; independently valid but mutually inconsistent references are impossible.
- Dispatch message ID globally unique.
- Supported schema version is exactly v6; compatibility means exact columns, keys, indexes, triggers, checks, foreign keys, and schema signature, not table names alone.
- Dispatch kind constrains whether `run_id` is required: executor and verifier dispatches require a Run, while approval reissue is Goal-scoped.
- Pending Executor and Verifier dispatches may have no target Session or directory until workspace preparation and child-Session binding complete; delivery validation requires both.
- Verification attempt number unique within a Run.
- Verification attempts are bounded to 1 through 8, with attempt 8 requiring explicit post-limit authorization.
- Goal, Run, approval, dispatch, role, priority, result, boolean, and counter values use database `CHECK` constraints.
- Revision body/hash and criteria are immutable. Evidence and audit history are append-only. A verification result may transition from pending to finalized exactly once and is immutable afterward.
- Sensitive values are redacted before audit or log persistence.
- Schema compatibility validates columns, keys, indexes, triggers, checks, `foreign_key_check`, and an exact schema signature rather than table names alone.

Criteria exist only in `acceptance_criteria`; `contract_revisions.body_json` contains only `ContractBody`. Revision reads hydrate criteria relationally and recompute the canonical aggregate hash when integrity is checked.

### 10.4 Store Facade

The Store is the only mutation authority. Its public operations are domain-specific and grouped by responsibility:

```text
Goal and Contract:
createGoal
proposeContract
bindApprovalQuestion
bindApprovalNativeRequest
queueApprovalReissue
resolveApproval
reviseGoal
cancelGoal

Workspace and Session binding:
recordWorkspacePrepared
activateRun
failRunPreparation
bindExecutorSession
bindVerifierSession
replaceVerifierSession

Control and verification:
pauseGoal
resumeAndDispatch
blockGoal
recordEvidence
proposeCompletion
recordVerificationAndMaybeRemediate

Dispatch compare-and-set:
validateDispatchForDelivery
markDispatchSent
markDispatchStarted
markDispatchCompleted
markDispatchFailed

Lease and recovery state:
acquireLease
renewLease
releaseLease
```

Runtime recovery is coordinated by the Orchestrator, not exposed as a generic Store mutation. Preparation retry, child-Session creation, prompt delivery, and filesystem/SDK work remain outside SQLite callbacks. Domain operations create their required dispatches in the same transaction as the state change; there is no public generic dispatch mutation that can create a crash gap. Every runtime mutation reloads its Goal, Run, revision, approval or dispatch preconditions and validates holder, expiry, and fencing token inside the same `BEGIN IMMEDIATE` write transaction. Goal creation initializes and acquires its lease atomically. Dispatch status changes use legal compare-and-set transitions and cannot overwrite cancellation or a later terminal disposition.

Audit records commit in the same transaction as the state change they describe. Runtime, hooks, commands, and tools never call low-level mutation queries directly.

SQLite callbacks never perform SDK, network, Question, Git, or filesystem operations.

### 10.5 Lease Lifecycle

Owned non-terminal Goals receive a lightweight ownership heartbeat well before lease expiry, and critical awaited operations renew before they cross a long external boundary. Clean disposal and terminal handling compare-and-set release only leases owned by the current instance. Recovery records the acquisition result and performs no SDK, filesystem, worktree, or prompt action for a Goal whose lease was not acquired.

The heartbeat establishes ownership only; it never drives workflow continuation and is not a Scheduler. A stale instance fails closed in both Store mutations and lifecycle hooks after another instance obtains a higher fencing token.

## 11. Commands and Tools

### 11.1 User Commands

```text
/goat <intent>
/goat
/goat status
/goat help
/goat pause
/goat resume
/goat revise <change>
/goat cancel
```

Semantics:

- `/goat <intent>` creates a `FORMING` Goal and starts the Formulator.
- `/goat` shows a concise one-screen status.
- `/goat status` shows detailed Contract, criteria, evidence, workspace, verification, and recent history.
- `/goat pause`, `resume`, `revise`, and `cancel` apply durable Store operations before presentation.
- `/goat help` shows short examples.

`clear`, `export`, and a separate evidence command are removed. If an active Goal exists, a new intent never overwrites it; the user is directed to revise, cancel, or use a new Session.

Goal creation persists the plugin instance's actual project directory and worktree origin. Before any mutating command, Goat resolves native Session metadata and requires a root Session with no parent. Status/help may remain observational, but child and Verifier Sessions cannot create a Goal, shadow a verifier binding, or issue pause/resume/revise/cancel.

`/goat revise <change>` preserves the original `sourceRequest`, stores the exact change in durable `formation_request`, invalidates pending approval and dispatch work, closes the current Run, and returns the Goal to `FORMING`. The Formulator reads the original request and the formation request through `goat_state`; a replacement Contract proposal clears `formation_request` atomically.

`/goat resume` is blocker-aware. A paused or blocked Run with a valid workspace atomically returns to `ACTIVE` and creates an executor-resume dispatch. A Run blocked during workspace preparation instead records a durable preparation retry while the Goal remains `BLOCKED`; only successful preparation moves it to `ACTIVE` and atomically creates the executor-resume dispatch. Resume never marks a Goal active without a valid approved workspace. After the seventh automatic verification failure, resume authorizes exactly one additional correction and verification cycle; it does not reset the automatic budget.

### 11.2 Model Tools

| Tool | Role | Responsibility |
| --- | --- | --- |
| `goat_state` | All Goat roles | Read current authoritative Goal state |
| `goat_contract_propose` | Formulator | Propose one immutable Contract revision |
| `goat_evidence_record` | Executor | Record immutable evidence for one criterion |
| `goat_completion_propose` | Executor | Request independent verification |
| `goat_block` | Executor | Persist an actionable blocker |
| `goat_verifier_report` | Verifier | Submit per-criterion findings |

Tools derive Session, Goal, role, and workspace from OpenCode context and Store bindings. They do not accept redundant `sessionID`, `goalId`, revision hash, fencing token, or approval identity from the model.

There is no generic `goat_transition` tool.

## 12. Activation, Workspace, and Dispatch

Approval activation follows a durable-before-external sequence:

```text
approval transaction
  -> approve revision
  -> create Run(status=PREPARING)
  -> create executor dispatch(status=PENDING, stable messageID)

outside transaction
  -> find or create the stable approved workspace

workspace transaction
  -> persist stable worktree identity and workspace path immediately

outside transaction
  -> await native worktree ready or failed
  -> capture actual HEAD, normalized status, and initial diff baseline

activation transaction
  -> persist baseline
  -> mark Run active
  -> move Goal to ACTIVE

outside transaction
  -> create or recover the Run-bound goat-executor child Session
  -> persist Executor Session identity and pinned model
  -> prompt goat-executor in the Run directory

dispatch transaction
  -> mark sent after the pinned OpenCode 1.18.11 prompt endpoint materializes the user message
```

If workspace preparation, readiness, Git probing, or baseline capture fails, one fenced Store transaction marks the preparing Run and Goal `BLOCKED`, records the dispatch disposition and audit event, and preserves an actionable reason. No executor prompt is issued and no fallback occurs.

Workspace rules:

- `current` uses the actual OpenCode project directory/worktree and requires a Git-backed workspace with a resolvable HEAD.
- `worktree` uses OpenCode's native worktree API.
- No custom Git worktree implementation or isolated-copy mode exists.
- Requested worktree failure never falls back to current workspace.
- Worktree names are stable from the Run ID. Preparation lists native worktrees first, reuses the exact name/path when present, and never creates a suffixed duplicate during recovery.
- A newly created worktree path is persisted before waiting for readiness. Recovery also handles the smaller crash window before path persistence by finding the stable name.
- Baseline capture starts only after native readiness. Recovery of an already-ready worktree uses a bounded Git readiness probe rather than waiting for an event that already occurred.
- Every Run stores the actual HEAD commit identity, normalized status, and initial diff before Executor dispatch. A branch name is never stored as a commit.
- Executor and Verifier use dedicated child Sessions and the Run's directory-scoped client or query.
- Verification captures a final workspace snapshot and Executor Session diff, compares both with the stored baseline, and blocks on conflicts, a missing workspace, changed identity, or unexplained concurrent user changes. File-set reconciliation is not a substitute for checking commit identity and normalized status/diff snapshots.
- Completed worktrees are preserved and reported; Goat does not auto-merge.
- Worktrees with changes are never auto-deleted.
- A cancelled clean worktree may be removed safely.

The `1.18.11` compatibility gate MUST prove worktree creation and directory-scoped Session prompting in a real OpenCode instance.

## 13. Dispatch and Idle Behavior

Dispatch states:

The only dispatch statuses are `PENDING`, `SENT`, `STARTED`, `COMPLETED`, `FAILED`, and `SUPERSEDED`.

```text
pending -> sent -> started -> completed
    |        |         |
    +------> started --+
    |        |
    +------> completed / failed

Any live dispatch -> superseded by an explicit pause, revise, cancel, or blocker operation
```

Dispatch kinds are explicit:

```text
approval-reissue
executor-initial
executor-remediation
executor-resume
verifier
```

Every dispatch persists its kind, Goal, optional Run, role, target Session when bound, explicit directory when bound, stable `msg_*` message ID, bounded canonical payload sufficient to reproduce the exact prompt, prompt hash, and status. Approval reissue is Goal-scoped; Executor and Verifier dispatches require a Run from the same Goal and approved revision. Pending Executor and Verifier dispatches may remain unbound until workspace and child-Session preparation completes.

Rules:

- A dispatch is durable before `promptAsync`.
- It carries a stable, unique message ID.
- It is marked sent only after the pinned OpenCode 1.18.11 endpoint materializes the prompt message.
- The adapter exposes V2 durable history/admission for diagnostics, but admission is not a Goat dispatch state and never replaces the materializing `promptAsync` endpoint.
- A definite validation or permission rejection may mark it failed. Timeout, disconnect, authentication uncertainty, or an unknown transport result remains reconcilable and is not guessed to be failure.
- Recovery queries stable message identity for both `PENDING` and `SENT`: existence reconciles to `SENT`, definitive not-found permits resend with the same ID, and lookup failure permits neither resend nor failure.
- Matching prompt events may mark `STARTED`; idle events never change dispatch state and are never used to infer completion.
- An idle Executor or Verifier never creates automatic continuation work. Continuation requires an explicit remediation, resume, or verifier dispatch.
- `/goat resume`, verifier remediation, and verifier startup create explicit dispatches through the same outbox.
- Terminal Goals, obsolete revisions, cancelled Runs, and dispatches superseded by a control operation are never delivered or replayed.

There is no Scheduler service, continuation counter, no-progress loop, budget scheduler, or generic retry workflow. A small per-Goal in-memory serialization queue may prevent concurrent hook handlers, but every queued action reloads Store state and remains correct after process loss. Prompt materialization, exact prompt events, Goat tool calls, and Store transitions provide the authoritative delivery and completion signals; no separate observation state is needed.

## 14. Evidence and Verification

Evidence is immutable and does not have an Executor-controlled accepted status.

```typescript
interface EvidenceRecord {
  criterionId: string
  source: string
  method: string
  expectedResult: string
  actualReference: string
  producer: string
}
```

Completion protocol:

```text
Executor calls goat_completion_propose
  -> Orchestrator captures final workspace and executor Session diff
  -> compare final state with the persisted baseline
  -> block on conflicts, missing workspace, or unexplained changes
  -> Store verifies every MUST has evidence and rechecks Run identity
  -> create verification attempt and pending verifier dispatch
  -> Goal ACTIVE -> VERIFYING
  -> create a new independent verifier Session
  -> Verifier inspects full Contract, baseline/final diff, and evidence
  -> Verifier calls goat_verifier_report
  -> Store validates findings and derives the outcome
```

Each Run owns one persisted Executor child Session. Each verification attempt owns one new Verifier child Session. Both are created under the originating root Session, bound to the Run directory, and receive the provider/model/variant persisted on the Run. Prompt delivery never overrides that model selection. If a crash occurs after Session creation but before binding, recovery matches the stable Goat metadata, Goal, Run, role, and attempt before creating or binding a replacement. A replacement is never created while a stable matching child already exists.

Verifier `goat_state` is a role-sensitive Store projection containing the full approved Contract, MUST and SHOULD criteria, evidence IDs and records, initial and final workspace snapshots, executor Session diff, attempt number, prior immutable findings, and current blocker. User-facing status uses a separate projection and does not expose these technical identities.

Verifier finding:

```typescript
interface VerificationFinding {
  criterionId: string
  result: "pass" | "fail" | "blocked"
  evidenceIds: string[]
  note?: string
}
```

The Verifier does not submit an overall verdict. Store derives it:

- Missing MUST finding or any MUST `fail`: Goal returns to `ACTIVE`.
- Any MUST `blocked`: Goal becomes `BLOCKED`.
- Every MUST `pass`: Goal becomes `COMPLETED` and the Run completes.
- SHOULD failures do not prevent completion but appear in the final report.

Missing MUST findings are derived as failures rather than leaving the Goal stranded in `VERIFYING`. Every passing MUST finding cites at least one evidence record. Every referenced evidence record must belong to the same Goal, approved revision, Run, and criterion. Notes are persisted, and SHOULD findings remain visible in the final report.

## 15. Bounded Automatic Remediation

Verification failure triggers a bounded domain workflow, not a generic idle continuation loop.

```text
verification fails
  -> atomically persist verification result
  -> atomically move Goal VERIFYING -> ACTIVE
  -> atomically create a remediation dispatch containing the exact findings
  -> preserve Run, workspace, code, and evidence
  -> dispatch findings to goat-executor
  -> Executor repairs and appends evidence
  -> Executor proposes completion again
  -> create a fresh verifier Session
```

Rules:

- A new Run receives at most seven automatic verification attempts.
- Attempt one is the initial verification; failures one through six may trigger automatic remediation.
- Every attempt uses a new Verifier Session.
- Existing evidence and prior results remain immutable.
- `blocked`, pause, cancel, lost workspace, or invalid revision stops the loop immediately.
- If the Executor becomes idle without completion or blocker reporting, Goat does not auto-prompt it again.
- A seventh failed attempt moves the Goal to `BLOCKED` and requests user action.
- After the automatic limit, `/goat resume` atomically authorizes one additional correction and verification cycle and creates one explicit executor-resume dispatch. A failure returns to `BLOCKED`; it does not reset the automatic budget.
- A newly approved Contract revision creates a new Run and resets the seven-attempt budget.
- A remediation or resume prompt rejection blocks actionably. An uncertain delivery remains in the outbox for stable-message reconciliation and never loses the findings.

User feedback remains concise, for example:

```text
Verification 2/7 failed. Goat is returning three findings to the Executor.
No changes were discarded.
```

## 16. Recovery

At startup, and at explicit recovery opportunities after restart or control commands:

```text
open and validate database
  -> create instance identity
  -> scan non-terminal Goals originating from this project/worktree
  -> acquire each available lease and retain the acquisition result
  -> classify durable state without mutation
  -> perform required SDK/filesystem reads only after lease acquisition
  -> apply one fenced recovery transaction per Goal
  -> issue only idempotent external work
```

Recovery handles:

- Expired or missing approval Questions.
- Pending and sent approval-reissue dispatches.
- Preparing Runs without a persisted workspace.
- Pending and sent executor dispatches.
- Pending and sent verifier dispatches.
- Missing or unbound Executor Sessions.
- Missing or unbound Verifier Sessions.
- Expired leases and stale fencing tokens.
- Missing worktree paths.
- Orphaned stable-name worktrees created before workspace persistence.
- Terminal Runs with leftover clean worktrees.

Recovery performs no external read or write for a Goal whose lease was not acquired. It processes one Goal at a time using persisted project origin and Run directory, never the current plugin instance's directory as an implicit substitute.

For uncertain dispatches, query the stable message ID:

- Message exists: reconcile Store status without resending; a matching prompt event may advance it to `STARTED`.
- A definitive not-found response: resend the same stable ID and persisted payload.
- Transport, server, or authentication failure: retain the durable state and retry reconciliation later without resending.

Approval recovery distinguishes a matching live Question, an expired live Question, an absent Question, and an explicitly dismissed or rejected Question. A missing Question creates one stable approval-reissue dispatch for the same immutable revision; it never creates another approval row or revision.

Preparing Runs discover and reuse stable-name worktrees. Executor recovery matches the persisted child-Session metadata and Run directory; Verifier recovery matches Goal, Run, role, attempt, and directory. Missing or unexpectedly dirty workspaces, changed HEAD identity, and unexplained status/diff changes block rather than being recreated or silently accepted.

Recovery never blindly repeats an arbitrary external side effect or the previous model action.

## 17. Context and Compaction

Goat never replaces or appends text to user message parts.

Dynamic context comes from:

- Role-sensitive `goat_state` at the start of Formulator, Executor, or Verifier work.
- Explicit executor and verifier dispatch prompts built from Store state.
- A minimal validated compaction context.

Compaction context contains Goal ID, state, approved revision hash, outcome, critical constraints, Run workspace, evidence coverage, active verifier attempt, and current blocker. Full Contract, evidence, diffs, and verification history are fetched through Store-backed tools rather than repeated in every prompt. Compaction never modifies or appends to user message parts.

If the required compaction hook is unavailable, startup compatibility fails for Goat-managed long-running work. Goat does not continue with silently lost constraints.

## 18. Presentation and User Experience

The native TUI is used without custom dialogs.

Approval shows only:

- Outcome.
- Included and excluded scope.
- Critical constraints.
- MUST criteria.
- Workspace strategy.
- Material assumptions.
- Revision diff when replacing a previously approved Contract.

UUIDs, hashes, call IDs, fencing tokens, and dispatch IDs are hidden from normal presentation.

`/goat` concise status fits one screen:

```text
Goat: Active
Outcome: Add reliable authentication
Workspace: worktree goat/auth
Evidence: 3/5 MUST criteria covered
Waiting: none
Next: Executor is working
```

`/goat status` provides the detailed human-readable view. There is no misleading `export` command that merely renders status.

Presentation has five pure projections:

| Projection | Content |
| --- | --- |
| Approval | Required Contract summary and material revision diff |
| Concise | State, outcome, workspace, MUST coverage, waiting reason, next action |
| Detailed | Contract, every criterion, evidence, Run, attempts, findings, blocker, recent audit history |
| Blocked | What failed, what was preserved, and the exact user action that can proceed |
| Completed | Independent MUST/SHOULD report and preserved workspace location |

Terminal Goals remain queryable for status and completion history. Internal IDs are omitted from normal projections but may appear in explicit diagnostics and the Verifier's model-only evidence context.

Use TUI toasts only for events requiring attention:

- Worktree preparation failed.
- Goal became blocked.
- Recovery completed with user-visible action.
- Verification passed or failed.
- Goal completed.

Do not toast ordinary tool calls, evidence records, or reads. Native Question already provides its own attention behavior.

Every user-facing error answers:

1. What happened.
2. Whether code or evidence was lost.
3. What command or action comes next.

Internal error codes and technical identities belong in structured logs and detailed diagnostics, not default messages.

## 19. Error Handling and Audit

Use one small `GoatError` shape with a stable code, safe message, and minimal diagnostic context. External input is validated with Zod at boundaries; internal code uses concrete types.

Do not swallow critical exceptions or substitute a best-effort audit event for a missing state transition.

Audit events cover:

- Goal creation and control commands.
- Contract proposal, approval, rejection, and revision.
- Run and workspace creation.
- Dispatch pending, sent, started, completed, and failed.
- Evidence recording.
- Verification attempts and findings.
- Automatic remediation.
- Blockers and recovery actions.
- Terminal transitions.
- Lease acquisition, takeover, renewal failure, and fenced recovery ownership changes when operationally significant.

Redact secrets and bound payload size before logging or persistence. Prefer references and hashes over raw command output or sensitive arguments.

## 20. Package and Configuration

Package identity:

```text
plugin: Goat
plugin ID: goat
npm: opencode-goat
command: /goat
tool prefix: goat_
```

The plugin is zero-configuration by default. Goat captures the root Session provider, model ID, and variant at Goal creation, persists them on the Goal and Run, and passes the pinned selection to every Executor and Verifier child Session. `OPENCODE_GOAT_HOME` may override the data directory and MUST resolve to an absolute path.

The OpenCode adapter uses the injected authenticated client for shared capabilities and preserves equivalent transport/authentication for any required V2-only client. It never assumes that `serverUrl` alone is sufficient authentication.

Startup verifies:

- Exact tested OpenCode compatibility.
- Required plugin and SDK methods.
- `/goat` does not conflict with another command.
- Required agents and native Question are available.
- Native permission behavior applies after Goat's role/lifecycle allowlist and never overrides a user deny or changes a user ask into an unconditional allow.
- Native worktree and directory-scoped prompting work when worktree mode is used.
- SQLite can open, lock, and validate the current schema.
- Executor and Verifier child Sessions can be created, bound, recovered, and prompted with the persisted model and exact Run directory.

`prepack` MUST build `dist`. Package smoke testing creates a real tarball, installs it into an isolated OpenCode configuration, compares source and packaged command/tool identifiers, and loads it through the real target release. The published package must not depend on install-time lifecycle scripts. Published source/declaration maps must resolve to packaged sources or be omitted, and package license metadata must have a matching license file.

## 21. Code Organization

```text
src/
  index.ts
  core/
    canonical.ts
    errors.ts
    state.ts
    contract.ts
    question.ts
    evidence.ts
    guard.ts
    ports.ts
    redaction.ts
  store/
    database.ts
    schema.ts
    store.ts
  runtime/
    data-home.ts
    process-context.ts
    orchestrator.ts
  opencode/
    adapter.ts
    hooks.ts
    commands.ts
    config.ts
    prompts.ts
  tools/
    state.ts
    contract-propose.ts
    evidence-record.ts
    completion-propose.ts
    block.ts
    verifier-report.ts
    deps.ts
  presentation.ts
```

Files may be combined when a boundary is too small to justify a module. Do not create empty abstractions to match this tree.

Code rules:

- Prefer pure Core functions and domain-specific names.
- Keep functions focused; keep logic local until reuse is real.
- Use specific Store operations instead of generic update methods.
- Use comments only for non-obvious constraints and crash-safety ordering.
- Keep `unknown` inside adapters and validation boundaries.
- Do not use dependency injection frameworks.
- Do not expose mutable repositories.
- Do not maintain two implementations of the same workflow.
- Remove obsolete or incorrect code encountered during implementation.
- Do not leave permissive placeholders such as unconditional no-conflict results, hard-coded Ready Gate success, unreachable command variants, unsupported criterion priorities, or unused Ports that imply behavior the runtime does not provide.
- A planned module such as Question mapping, child-Session binding, or deferred recovery is either connected to the production path and tested or removed. Dead source and generated output are not packaged.

## 22. Removed Legacy Design

The implementation MUST delete, not preserve, these old concepts:

```text
OpenCode 1.17.18 compatibility branches
/goal and goal_* plugin identifiers
schema v1 compatibility and migration paths
durable Decision Cards and goat_decision_prepare
Contract tool permission lists
capability challenges and one-time grants
goat_grant_request
semantic policy classifier
general child tasks and capability subsets
isolated-copy workspace mode
automatic idle continuation Scheduler
goat_progress
generic goat_transition
model-visible complete transition
chat.message context replacement
/goat clear, export, and evidence commands
deprecated revision, completion, and verifier operations
direct repository mutations outside Store
stale checked-in dist artifacts
prefix-wide goat_* lifecycle bypass
criteria duplicated in Contract JSON and relational rows
branch names stored as commit identities
URL-only SDK clients that discard injected authentication semantics
fire-and-forget critical command transitions
```

Domain names such as `Goal`, `GoalContract`, `GoalState`, `goalId`, and SQL `goal_id` remain valid. Only plugin-facing identifiers use the Goat namespace.

## 23. Implementation Order

This is construction order, not a reduced product release plan.

1. Verify the exact OpenCode `1.18.11` plugin, injected-client, V2 SDK, Question, permission, worktree readiness, TUI, Session, diff, message, and compaction contracts.
2. Finalize pure Core state, Contract, Question mapping, evidence, finding derivation, and exact lifecycle guard behavior.
3. Replace persistence with the single strict 10-table schema, exact signature validation, composite integrity, immutability, and domain-specific Store facade.
4. Implement fenced transactional mutations, lease acquire/renew/release, legal dispatch CAS transitions, and per-Goal same-instance serialization.
5. Implement root-only commands, role/directory-bound tools, restrictive agent and child-Session permissions, Formulator discovery, Contract proposal, native approval, and Question reconciliation.
6. Implement current/worktree two-phase preparation, readiness, stable reuse, real baseline capture, activation, persisted provider/model/variant, Run-bound Executor Session creation, and initial Executor outbox delivery.
7. Implement Evidence, final workspace comparison, independent Verifier child-Session context, finding derivation, seven-attempt limit plus one explicit attempt-8 authorization, atomic remediation, and explicit resume dispatch.
8. Implement per-project startup recovery for approval, lease, workspace, Executor/Verifier child Sessions, stable message IDs, pending/sent dispatch crash windows, and minimal compaction context.
9. Implement approval, concise, detailed, blocker, completion, and diagnostic projections; then delete obsolete, dead, placeholder, duplicate, and stale generated code.
10. Run full Core/Store/integration/recovery/adversarial validation, clean build, real tarball install, authenticated OpenCode current/worktree smoke, and platform checks.

Tests accompany each construction step. A later phase never relies only on direct Store tests when the required behavior crosses hooks, adapters, or external APIs.

## 24. Test Strategy

Tests are organized by behavior, not historical implementation phase.

Core tests:

- State legality and terminal absorption.
- Contract canonicalization and aggregate hash.
- Ready Gate.
- MUST evidence and finding derivation.
- Lifecycle guard by role, state, exact tool ID, lease ownership, and workspace identity.
- Missing MUST, SHOULD failure, blocker, seventh-attempt, and post-limit result derivation.

Store tests:

- Fresh schema signature, `foreign_key_check`, checks, indexes, triggers, and rejection of incompatible databases.
- One active Goal and Run invariants.
- Revision, criterion, Evidence, finalized result, and audit immutability.
- Composite Goal/Run/revision/criterion/approval identity integrity.
- Exact approval binding and stale rejection.
- Lease acquire, heartbeat renewal, clean release, expiry takeover, and stale fencing with two Store instances.
- Legal durable dispatch transitions and cancellation races.
- Same-instance concurrent pause/revise/evidence/completion serialization.
- Workspace failure blocking, blocked-Run revision, atomic remediation, explicit resume, and completion transactions.
- Preparation-blocked resume persists a retry, remains blocked during external preparation, and dispatches only after successful activation.

Integration tests:

- `/goat` intent through approval and executor prompt.
- Ordinary native Question without durable Decision state.
- Approval approve, revise, cancel, reject, expiry, lost Question, and replay through real hooks.
- Executor child Session permission envelope, role allowlists, and native user permission `allow`, `ask`, and `deny` compose without a Goat rule overriding a user deny or changing a user ask into an unconditional allow; existing Formulator/Verifier denies survive config registration.
- Non-Goal Sessions remain unaffected; child and Verifier Sessions cannot create or control Goals.
- Exact six-tool bypass; malicious prefixed, unknown custom, MCP, and task tools fail closed in restricted states, and the Executor `question` permission is denied.
- Current workspace and native worktree execution use the exact persisted directory for tools, prompts, messages, and diffs.
- Executor initial, remediation, resume, and Verifier dispatches target the correct persisted child Session, provider/model/variant, directory, and stable `msg_*` identity.
- Evidence through successful completion.
- Verifier receives complete evidence/diff context and handles fail, block, pass, SHOULD failure, missing finding, and stale identity.
- Seven failed attempts become blocked; explicit resume authorizes exactly one additional attempt-8 correction/verification cycle without resetting the automatic budget.
- Explicit resume atomically dispatches one post-limit correction cycle and does not reset the automatic budget.
- Status and actionable errors.

Recovery tests:

- Crash after approval commit but before workspace creation.
- Crash after native worktree creation but before path persistence.
- Crash after path persistence/readiness/baseline but before activation commit.
- Pending and sent message exists, definite not-found, and transient lookup failure after prompt delivery begins.
- Live, lost, expired, rejected, and dismissed approval Question.
- Executor/Verifier child Session created before binding, stable metadata reuse, and lost child Session replacement.
- Restart between verification result and remediation, and after atomic remediation before prompt delivery.
- Lease held by another instance and lease takeover during recovery.
- Goals from two project origins recover only in their own project instances.
- Missing, dirty, changed-HEAD, or unexplained-status worktree.
- Existing stable-name orphan worktree is reused without duplicate creation.

Adversarial tests:

- Write attempt before approval.
- Side-effecting unknown `goat_*`, custom, MCP, and child-task calls before approval or while restricted.
- Fabricated or stale approval.
- Changed criteria after approval.
- Executor completion claim without evidence.
- Executor or Verifier mutation from the wrong agent, Session, lease holder, or directory.
- Evidence from another revision or criterion.
- Prompt injection attempting to alter Goal state.
- User permission deny overridden by plugin configuration.
- Unexplained concurrent user changes, changed HEAD, and workspace conflicts before verification.

Artifact tests:

- Typecheck and complete test suite.
- Windows, Linux, and macOS path behavior where CI is available.
- Built tarball installation in an isolated environment.
- Package export, source/package command and tool identifier equivalence, and packaged source/declaration resolution.
- Real authenticated latest-stable OpenCode plugin load and minimal lifecycle.
- Real current-workspace and native-worktree directory-scoped flows.
- Published files contain a matching license and no broken source/declaration maps.

## 25. Definition of Done

Goat is complete only when:

- `/goat` creates and owns a durable `FORMING` Goal without manual database work.
- Discovery and ordinary native Questions cannot write the target project.
- A valid Contract aggregate can be proposed, hashed, displayed, and exactly approved.
- Approval creates a preparing Run and durable dispatch; only successful workspace readiness and baseline persistence activate the Run, create or recover its bound `goat-executor` child Session, and dispatch the pinned Executor model in the exact Run directory.
- The root provider/model/variant is persisted and reused by the Run's Executor and every Verifier child Session without silent reselection.
- User OpenCode permission rules remain authoritative after Goat's role/lifecycle allowlist; Goat cannot override a user deny or convert a user ask into an unconditional allow.
- Only the exact six Goat tools bypass the generic guard, and each still validates role, state, lease, and workspace.
- Worktree execution is genuinely directory-scoped, reuses stable worktrees after restart, waits for readiness, and never silently falls back.
- Every approval, executor, remediation, resume, and verifier dispatch boundary is crash-recoverable by stable `msg_*` identity and persisted payload; pending child dispatches bind their target Session and directory before delivery.
- Executor evidence is linked to the approved criterion and revision.
- A separate read-only Verifier receives the complete approved Contract, Evidence, baseline/final diff, and history and evaluates every MUST criterion.
- Failed verification atomically dispatches at most six automatic remediations; the seventh failure blocks, and explicit resume grants only one additional attempt-8 correction/verification cycle without resetting the automatic budget.
- No path reaches `COMPLETED` without all MUST findings passing.
- Non-Goat Sessions are unaffected.
- All state mutations go through fenced Store transactions, leases remain live during long work, and recovery performs no external action without ownership.
- Exactly schema v6 enforces relational identity, enum validity, immutability, model pinning, revocable child-Session binding, dispatch identity, attempt-8 authorization, and append-only audit history without compatibility migrations.
- No legacy Grant, Decision Card, general child task, idle continuation Scheduler, generic transition, compatibility branch, or direct repository write remains; Goat workflow child Sessions are explicit and persisted, not general child tasks.
- User messages are never replaced by Goat context.
- `/goat` and `/goat status` provide concise, detailed, blocker, and terminal completion views without exposing internal IDs by default.
- Typecheck, coverage-gated full tests, clean build, real tarball install, authenticated latest-stable OpenCode current/worktree load, and available platform checks all pass.

## 26. References

- OpenCode Plugins: <https://opencode.ai/docs/plugins/>
- OpenCode Commands: <https://opencode.ai/docs/commands/>
- OpenCode Custom Tools: <https://opencode.ai/docs/custom-tools/>
- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenCode Server: <https://opencode.ai/docs/server/>
- OpenCode Permissions: <https://opencode.ai/docs/permissions/>
- OpenCode releases: <https://github.com/anomalyco/opencode/releases>
- Plugin hook source: <https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts>
- Question source: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts>
- Tool execution source: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts>
