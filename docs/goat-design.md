# Goat for OpenCode: Design

Goat means **Goal Operationalization, Alignment & Testing**.

This document is the normative design for the current alpha line. It describes
the behavior and boundaries that implementation, tests, and release checks must
agree on. It is intentionally smaller than a generic workflow framework.

## 1. Product Objective

Goat turns an incomplete request into a durable, approved, and verifiable
development workflow:

```text
intent
  -> read-only discovery
  -> immutable Contract
  -> exact native approval
  -> approved workspace execution
  -> evidence and tests
  -> independent verification
  -> completion, correction, or actionable blockage
```

Goat must:

- preserve the user's original request;
- ask only decisions that affect the outcome;
- require approval of an exact Contract before project writes;
- keep OpenCode permission rules authoritative;
- persist approvals, dispatches, transitions, evidence, and findings;
- recover safely from process interruption and uncertain prompt delivery;
- require evidence and an independent Verifier for every MUST criterion.

Goat must not:

- infer approval from model prose;
- silently change scope, constraints, criteria, or workspace strategy;
- silently fall back from a requested worktree to the current workspace;
- claim that it is an operating-system sandbox;
- automatically commit, merge, push, or delete a worktree;
- preserve compatibility branches for old Goat schemas or APIs.

## 2. Design Principles

### Contract before authority

No persistent target-project write is allowed before an exact Contract revision
is approved.

### SQLite is authoritative

Prompts, model context, toasts, and status output are projections. They never
replace durable state.

### Reuse OpenCode

Goat uses native Question, permission, bash, Session, worktree, diff, message,
event, and TUI APIs. It adds only Goal-specific persistence and policy.

### Durable before external

The intent to send a prompt or start a Run is committed before the external
operation. Stable message IDs reconcile uncertain delivery.

### Simple but not simplistic

The design keeps explicit domain boundaries, relational integrity, lease
fencing, and crash recovery. It does not add a workflow engine, event bus,
dependency-injection framework, general scheduler, or cloud service.

## 3. OpenCode Boundary

OpenCode compatibility is a release-time fact, not a floating promise. The
plugin and SDK dependencies are pinned to the exact version used to build a
release. The package `engines.opencode` range may cover more than one patch
only after those versions pass the real package-load and workflow smoke tests.

The adapter uses the injected authenticated client. A V2 client is allowed only
for capabilities unavailable through the injected surface and must preserve the
same authentication and directory scope.

Goat relies on:

- plugin config and command hooks;
- `tool.execute.before` and `tool.execute.after`;
- native Question and native permission;
- directory-scoped Session APIs;
- native worktree APIs;
- Session message lookup and diff;
- Session lifecycle events;
- TUI toasts and compaction hooks.

Rules:

- Every Session, Question, message, diff, VCS, and worktree call carries the
  persisted project or Run directory.
- Critical transitions are awaited in command or tool hooks.
- Events trigger reconciliation; they never independently infer completion.
- The implementation does not import OpenCode internal services.
- Startup checks every API that production code actually invokes.
- Real authenticated package-load and current/worktree smoke establish release
  compatibility; property-existence checks alone are insufficient.

Goat's enforcement claim is limited to calls observed by its awaited hook and
OpenCode's permission system. Bash, another process, Git configuration, mounts,
hard links, and external services may have effects outside that envelope.

## 4. Architecture

```text
OpenCode Edge
  hooks / commands / tools / adapters
          |
          v
Orchestrator
  InvocationPolicy
  DispatchDriver
  WorkspaceSafety
          |
          v
Store
  approval transactions
  run/control transactions
  verification transactions
  typed reads and codecs
          |
          v
SQLite Schema v7

Core
  Contract / lifecycle / approval / evidence / snapshots / role policy
```

| Area | Responsibility |
| --- | --- |
| Core | Pure domain schemas, transitions, approval mapping, evidence derivation, and snapshot comparison |
| Store | SQLite schema, typed reads, leases, and all authoritative mutations |
| Runtime | Session coordination, workspace activation, dispatch, verification, and recovery |
| OpenCode | SDK adapter, hooks, commands, agents, prompts, and native permission boundary |
| Tools | Thin model-facing Goat operations |
| Presentation | Pure human-readable projections |
| `index.ts` | Construction, registration, and disposal |

Only two objects own workflow state:

- `Store` is the sole database mutation authority.
- `Orchestrator` coordinates external work and reloads durable state.

The Runtime helpers are stateless coordinators:

- `InvocationPolicy` centralizes role, Session, state, directory, model, and
  lease checks.
- `DispatchDriver` centralizes stable-message delivery and reconciliation.
- `WorkspaceSafety` centralizes path, Git identity, snapshots, and attribution.

Core does not import OpenCode, SQLite, network, or real filesystem services.
Store does not call SDK, Git, or filesystem APIs. SQLite callbacks never call
external systems.

Do not add Repository, Unit of Work, service-container, public event-bus, or
generic state-machine abstractions.

## 5. Roles and Sessions

| Agent | Responsibility | Boundary |
| --- | --- | --- |
| `goat-formulator` | Discovery, clarification, Contract drafting | Root Session; read-only plus native Question |
| `goat-executor` | Execute the approved Contract | One child Session per Run; approved workspace and native bash |
| `goat-verifier` | Independently verify each criterion | One child Session per verification attempt; Run directory bound |

The root Session pins provider, model, variant, project, workspace, and
directory. Executor and Verifier children use that persisted model selection.
Prompt delivery never silently selects a different model.

Unbound ordinary OpenCode Sessions are not controlled by Goat. An unbound
Session using a reserved `goat-*` agent fails closed. A bound child Session must
match its persisted project, workspace, parent, directory, agent, model, and
metadata before any Goat operation.

The Executor may use OpenCode's native `bash`, `read`, search, edit, write, and
patch tools after approval. The Verifier may use read/search and native bash
only for commands present exactly in the approved Contract. Native permission
evaluation remains final. Goat never adds an allow rule that broadens a user
deny or converts a user ask into unconditional allow.

## 6. Lifecycle

Goal states:

```text
FORMING
AWAITING_APPROVAL
ACTIVE
VERIFYING
PAUSED
BLOCKED
COMPLETED
CANCELLED
```

Run states:

```text
PREPARING
ACTIVE
FINALIZING
VERIFYING
PAUSED
BLOCKED
COMPLETED
CANCELLED
```

Important transitions:

```text
FORMING -> AWAITING_APPROVAL
AWAITING_APPROVAL -> ACTIVE | FORMING | BLOCKED | CANCELLED
ACTIVE (Goal) -> PAUSED | BLOCKED | FORMING | CANCELLED
ACTIVE (Run) -> FINALIZING | PAUSED | BLOCKED | CANCELLED
FINALIZING -> VERIFYING | BLOCKED | CANCELLED
VERIFYING -> COMPLETED | ACTIVE | BLOCKED | CANCELLED
PAUSED -> ACTIVE | BLOCKED | FORMING | CANCELLED
BLOCKED -> ACTIVE | AWAITING_APPROVAL | FORMING | CANCELLED
```

`FINALIZING` prevents new Executor writes while the final workspace and Session
diff are captured. Pause persists a checkpoint, interrupts the Executor, and
then remains PAUSED. If a process stops between those operations, recovery
finishes the checkpoint or reports an actionable blocker.

Invariants:

- Before `ACTIVE`, no target-project persistent write exists.
- `ACTIVE`, `FINALIZING`, and `VERIFYING` bind one approved revision and Run
  workspace.
- Mutations and external Goat dispatch require an owned, unexpired lease.
- A material Contract change creates a new immutable revision and approval.
- Completion requires every MUST criterion to pass independently.
- Cancel and revise preserve all worktrees and workspace changes.

## 7. Contract and Verification Plan

A Contract revision is an immutable aggregate containing outcome, scope,
constraints, assumptions, workspace strategy, and criteria.

```typescript
interface AcceptanceCriterion {
  id: string
  priority: "must" | "should"
  description: string
  verification: VerificationStep[]
}

type VerificationStep =
  | { kind: "inspection"; description: string }
  | { kind: "command"; command: string; timeoutSeconds?: number }
```

The source request is copied from durable Goal state and cannot be rewritten by
the model. Corrections create a new revision. Revision hashes cover canonical
Contract body and criteria sorted by stable ID.

The Ready Gate requires:

- observable outcome;
- explicit included and excluded scope;
- reviewed constraints and assumptions;
- at least one MUST criterion;
- stable unique criterion IDs;
- a verification plan for every criterion;
- resolved outcome-changing questions;
- an available workspace strategy.

Approval displays the exact Contract, material revision difference, workspace,
verification commands, and the ten-round automatic iteration limit.

## 8. Approval

```text
goat_contract_propose
  -> validate Contract and Ready Gate
  -> persist immutable revision and criteria
  -> persist canonical approval payload and expiry
  -> native Question
  -> before-hook binds real call/request identity
  -> after-hook maps exact labels
  -> Store resolves approval atomically
```

Choices are `Approve and start`, `Revise`, and `Cancel`. Approval binds Goal,
revision, hash, root Session, canonical payload, option mapping, expiry, and
answer.

On restart:

- a matching Question preserves its binding;
- a missing Question creates one stable reissue dispatch for the same revision;
- an expired Question is rejected and reissued with a new generation;
- a dismissed or rejected Question becomes a durable blocker.

Every reissue generation has at most one live dispatch. Binding, answering,
rejecting, or expiring an approval terminates its related reissue dispatch.
Reissue reconstructs the original Contract summary and never nests approval
sentences.

## 9. Permission and Invocation Policy

Goat implements a structural workflow ceiling, not a second permission system.
The common invocation path validates:

```text
registered tool
Session identity
role and agent
Goal and Run state
project and workspace identity
parent Session
model and metadata
current verification attempt
live lease and fencing token
```

The ordering is:

```text
structural authorization
  -> OpenCode native permission
  -> reload state and lease
  -> mutation or external call
```

Unknown tools, MCP tools, task tools, and unbound reserved agents fail closed
only when they are in a Goat-managed Session. Unrelated Sessions remain under
OpenCode's native policy.

## 10. Persistence: Schema v7

Schema v7 is created and validated as one exact schema. Old versions are not
migrated. A mismatch fails startup without modifying the database and includes
the affected path in the recovery message.

Tables:

| Table | Purpose |
| --- | --- |
| `goals` | Source request, root identity, model, state, revision, and blocker |
| `contract_revisions` | Immutable Contract body and hash |
| `approval_attempts` | Approval generations, payload, binding, answer, and expiry |
| `acceptance_criteria` | Immutable criteria belonging to a revision |
| `runs` | Approved workspace, baseline, Session, status, attempt count, batch number, and explicit preparation retry intent |
| `dispatches` | Durable prompts with stable message IDs and delivery state |
| `evidence` | Immutable criterion evidence |
| `verification_results` | Per-attempt findings and derived outcome |
| `session_bindings` | Active and revoked Executor/Verifier bindings |
| `leases` | Fenced Goal ownership |
| `audit_events` | Append-only critical history |

The v7 implementation keeps the schema small. A separate check-run,
verification-batch, receipt, or finalization table is not required. Verification
batch and round derive from `runs.verification_attempts` and
`runs.verification_batch`; Run `FINALIZING` is the recovery marker.

Integrity rules include foreign keys, immutable revision and evidence records,
typed JSON codecs, strict payload limits, canonical hashes, legal dispatch
compare-and-set transitions, and recomputed workspace digests.

## 11. Workspace Safety

- Worktree is the recommended strategy; current workspace is explicit.
- A requested worktree never silently falls back to current workspace.
- Native worktrees are checked against Git common directory and real path.
- `.git`, git-dir, git-common-dir, ignored targets, and path escapes are denied
  for direct file tools.
- Windows roots, UNC paths, POSIX paths, case behavior, Unicode, and legal
  filenames are handled according to the host platform.
- Add, update, delete, and move patch destinations are all validated.
- Symlink, junction, and reparse-point escapes fail closed.
- Current workspace must be clean before approval.
- Worktrees are preserved after completion, cancellation, and revision.

Goat does not promise to observe every effect of arbitrary bash. It relies on
OpenCode permission rules and final Git/Session reconciliation rather than
claiming process or OS isolation.

Completion compares the final snapshot with the baseline and the actual
Executor Session diff. Path history alone is never attribution. If the Session
does not provide a complete, matching diff, completion blocks rather than
guessing ownership. Verifier before/after snapshots must also match exactly.

## 12. Dispatch and Recovery

All dispatches follow one path:

```text
durable dispatch
  -> ensure target Session
  -> lookup stable message ID
  -> exists: mark sent
  -> definitive missing: send same ID
  -> unknown: retain state and reconcile later
  -> definite rejection: commit phase-specific failure
```

Dispatch states are `PENDING`, `SENT`, `STARTED`, `COMPLETED`, `FAILED`, and
`SUPERSEDED`. Idle events never imply completion or continuation. There is no
generic retry scheduler.

Recovery runs at startup, after relevant events, and on explicit `/goat resume`.
It acquires a Goal lease first, reloads durable state, validates the persisted
directory, and performs one fenced action at a time. It never uses the current
plugin directory as an implicit substitute.

Recovery covers missing Questions, uncertain prompts, preparing Runs, child
Session replacement, missing worktrees, pending verification, stale leases,
and finalization after interruption. It never repeats an uncertain external
side effect without stable-message or identity reconciliation.

## 13. Ten-round Automatic Iteration

Each verification attempt is one round. The first attempt is round 1.

```text
batch = floor((attempt - 1) / 10) + 1
round = ((attempt - 1) mod 10) + 1
```

The verifier derives the outcome:

- `PASS`: every MUST passes with valid evidence;
- `FAIL`: at least one MUST fails;
- `ERROR`: a technical or permission failure prevented a complete check;
- `PENDING`: no report has been committed yet.

Only PASS may finish the Goal. FAIL and ERROR continue the current batch. A
blocked finding also continues until round 10. No-progress detection is shown
for diagnosis but never stops automatic iteration.

After round 10 without PASS, the Goal becomes BLOCKED. `/goat resume` explicitly
starts the next ten-round batch. Process failure, database failure, and lost
lease pause recovery without inventing a failed round.

Every round receives a new Verifier Session. Prior evidence and findings remain
immutable. Remediation dispatches carry the exact persisted findings to the
Executor.

## 14. Commands and Presentation

```text
/goat <intent>
/goat
/goat status
/goat doctor
/goat help
/goat pause
/goat resume
/goat revise <change>
/goat cancel
```

`status`, `help`, and `doctor` are observational. Control commands require the
originating root Session. Child Sessions may inspect but cannot control the
Goal.

`/goat doctor` reports Goat schema, Git state, project/worktree paths, and
workspace identity. CLI compatibility is enforced by `engines.opencode`,
adapter API-shape checks, and authenticated smoke rather than by doctor.

Concise status includes actual phase, workspace, MUST coverage, delivery and
Session condition, current round, and one next action. Detailed status includes
Contract assumptions, verification commands, evidence references, findings,
approval expiry, model, timestamps, and preserved worktree. Internal IDs and
error codes stay out of normal output.

Every user-facing error says what happened, what was preserved, and what to do
next.

## 15. Testing and Release

The required CI matrix is Ubuntu, Windows, and macOS. It runs frozen install,
typecheck, coverage-gated tests, package smoke, and package-root OpenCode load
smoke. Authenticated smoke runs against the minimum CLI and `latest` using the
same candidate package.

Tests must cover:

- native path and Git metadata boundaries;
- reserved-agent and native permission composition;
- multi-worktree context isolation;
- lease takeover and await-time races;
- approval and dispatch crash windows;
- Executor and Verifier interruption;
- ten-round failure, error, and tenth-round pass;
- a second ten-round batch after resume;
- real file-backed SQLite and concurrent initialization;
- current and native worktree end-to-end flows;
- package installation through `exports["./server"]`.

Release is tag-driven. One candidate tarball is used for package smoke,
OpenCode smoke, and npm publication. Prereleases use `alpha`, `beta`, or `rc`;
`latest` is reserved for stable releases. npm OIDC Trusted Publishing and
provenance are required for public release.

## 16. Code Organization

```text
src/
  core/       contract, state, evidence, question, policy, workspace rules
  store/      database, schema, codecs, reads, domain transactions, facade
  runtime/    orchestrator, invocation, dispatch, workspace, process context
  opencode/   adapter, hooks, commands, config, prompts
  tools/      thin Goat tools
  presentation.ts
  index.ts
```

Keep functions focused and names domain-specific. Keep `unknown` at adapters
and validation boundaries. Use comments only for non-obvious safety ordering.
Delete obsolete code instead of preserving dead compatibility paths. A planned
module must be connected to production code and tested, or it must not exist.

## 17. Removed Designs

The current line does not contain or preserve:

```text
old Goat schema migration branches
Contract permission languages
capability grants or challenges
durable Decision Cards
generic child-task orchestration
isolated-copy workspace mode
automatic worktree cleanup
idle continuation scheduler
generic goat_transition
model-visible completion transition
duplicate source/criteria representations
path-only Executor attribution
unbound reserved-agent access
automatic seven/eight-attempt authorization
```

These removals are deliberate. They reduce the number of independent state
machines while preserving the safety properties that users can understand and
test.
