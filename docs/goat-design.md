# Goat for OpenCode: Design

Goat means **Goal Operationalization, Alignment & Testing**.

This document is the normative design for the current alpha line. It describes
the behavior and boundaries that implementation, tests, and release checks must
agree on. It is intentionally smaller than a generic workflow framework.

## 1. Product Objective

Goat turns an incomplete request into a durable, approved, and verifiable
development workflow:

```text
Goal -> Plan -> Approve -> Execute -> Verify -> Done
```

Planning is read-only. Approval authorizes preparation of one native Git
worktree. Execution and independent verification happen only in that worktree;
a failed verification may return findings for bounded remediation.

Goat must:

- preserve the user's original request;
- ask only decisions that affect the outcome;
- require approval of an exact Contract before creating or changing an
  execution worktree;
- keep OpenCode permission rules authoritative;
- persist approvals, dispatches, transitions, evidence, and findings;
- recover safely from process interruption and uncertain prompt delivery;
- require evidence and an independent Verifier for every MUST criterion;
- hand off execution and verification only after the responsible Session is
  idle.

Goat must not:

- infer approval from model prose;
- silently change scope, constraints, or criteria;
- execute in the source checkout or any directory other than the approved
  native worktree;
- claim that it is an operating-system sandbox;
- automatically commit, merge, push, or delete a worktree;
- wait for Session idle or interrupt a Session from a completion/report tool;
- preserve compatibility branches for old Goat schemas or APIs.

## 2. Design Principles

### Contract before authority

No persistent target-project write is allowed before an exact Contract revision
is approved.

### SQLite is authoritative

Prompts, model context, toasts, and status output are projections. They never
replace durable state.

### One lifecycle authority

`goals.state` is the only authoritative workflow state. Run, dispatch,
Session-binding, approval, and verification records provide facts used by the
workflow; none owns a second lifecycle.

### Reuse OpenCode

Goat uses native Question, permission, bash, Session, worktree, diff, message,
event, and TUI APIs. It adds only Goal-specific persistence and policy.

### Durable before external

The intent to send a prompt or start a Run is committed before the external
operation. Stable message IDs reconcile uncertain delivery.

### Idle-bound handoffs

Completion and verification report tools durably record a proposal or report
and return. A later Session idle event triggers reconciliation and finalization;
the tool call itself never waits for idle and never interrupts its Session.

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
  persisted project or Goal worktree directory.
- Command and tool hooks await only their own validation and durable writes.
- Session idle events trigger completion/report reconciliation; idle alone
  never proves that work completed.
- The implementation does not import OpenCode internal services.
- Startup checks every API that production code actually invokes.
- Real authenticated package-load and worktree workflow smoke establish release
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
  lifecycle/control transactions
  verification transactions
  typed reads and codecs
          |
          v
SQLite Schema v9

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

Workflow responsibilities are limited to two objects:

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
| `goat-executor` | Execute or remediate the approved Contract | Child Session bound to the approved worktree; authority only in `EXECUTING` |
| `goat-verifier` | Independently verify each criterion | One child Session per verification attempt; authority only in `VERIFYING` |

The root Session pins provider, model, variant, project, workspace, and
directory. Executor and Verifier children use that persisted model selection.
Prompt delivery never silently selects a different model.

Unbound ordinary OpenCode Sessions are not controlled by Goat. An unbound
Session using a reserved `goat-*` agent fails closed. A bound child Session must
match its persisted project, workspace, parent, directory, agent, model, and
metadata before any Goat operation.

The source checkout remains read-only. The Executor may use OpenCode's native
`bash`, `read`, search, edit, write, and patch tools in the approved worktree
only while `goals.state` is `EXECUTING`. The Verifier may use read/search and
native bash only while `goals.state` is `VERIFYING`, and only for commands
present exactly in the approved Contract. Native permission evaluation remains
final. Goat never adds an allow rule that broadens a user deny or converts a
user ask into unconditional allow.

No role has worktree authority in `PREPARING`, either finalization state,
`PAUSED`, `BLOCKED`, or a terminal state. A state transition closes role
authority before any external finalization or checkpoint work begins.

## 6. Lifecycle

`goals.state` has exactly these values:

```text
PLANNING
AWAITING_APPROVAL
PREPARING
EXECUTING
FINALIZING_EXECUTION
VERIFYING
FINALIZING_VERIFICATION
PAUSED
BLOCKED
COMPLETED
CANCELLED
```

There is no `runs.state`. The nominal path is:

```text
PLANNING
  -> AWAITING_APPROVAL
  -> PREPARING
  -> EXECUTING
  -> FINALIZING_EXECUTION
  -> VERIFYING
  -> FINALIZING_VERIFICATION
  -> COMPLETED
```

Approval moves the Goal to `PREPARING`; only then may Goat create and validate
the native worktree and bind an Executor Session. A non-passing finalized
verification moves to `PREPARING` for remediation when the current batch still
has capacity, or to `BLOCKED` when it does not.

Handoffs are event-driven:

```text
EXECUTING
  -> completion proposal is persisted and the tool returns
  -> Executor Session idle event
  -> FINALIZING_EXECUTION
  -> VERIFYING

VERIFYING
  -> verifier report is persisted and the tool returns
  -> Verifier Session idle event
  -> FINALIZING_VERIFICATION
  -> COMPLETED | PREPARING | BLOCKED
```

The completion/report tools do not transition into finalization, wait for idle,
poll, or interrupt their Session. On the matching idle event, reconciliation
checks the durable proposal/report and Session identity, then transitions out
of the authority-bearing state before capturing final snapshots and diffs. An
idle Session without the matching durable proposal/report does not advance.

Pause closes authority before checkpointing. One Store transaction records the
phase-specific route in `goals.resume_state`, changes `goals.state` to `PAUSED`,
and revokes the active role binding. Only after that transaction may Goat
interrupt the Session or capture the checkpoint. If checkpointing fails, the
Goal remains safely closed and recovery reports an actionable blocker.

`/goat resume` always reads `resume_state` and invokes that phase's recovery
path. It does not restore a generic active state. Workspace, Session, lease,
dispatch, and approval facts are revalidated before `EXECUTING` or `VERIFYING`
authority can be opened again. `BLOCKED` likewise persists the route that an
explicit resume should take.

Revision closes any role authority and returns to `PLANNING` with a new
immutable Contract revision. Cancellation closes authority and moves to
`CANCELLED`. Neither operation removes an existing worktree or its changes.

Invariants:

- Before approval, no execution worktree exists and no target-project
  persistent write is allowed.
- The source checkout is never an execution workspace.
- `PREPARING`, `EXECUTING`, `FINALIZING_EXECUTION`, `VERIFYING`,
  `FINALIZING_VERIFICATION`, and `COMPLETED` bind one approved revision and Run
  record. The native worktree path becomes available during `PREPARING`.
- `PAUSED` and `BLOCKED` may occur before or after approval; `resume_state` and
  the persisted approval/Run facts determine their recovery route.
- Executor authority exists only in `EXECUTING`; Verifier authority exists only
  in `VERIFYING`.
- Mutations and external Goat dispatch require an owned, unexpired lease.
- A material Contract change creates a new immutable revision and approval.
- Completion requires every MUST criterion to pass independently.
- Cancel and revise preserve all worktrees and workspace changes.

## 7. Contract and Verification Plan

A Contract revision is an immutable aggregate containing outcome, scope,
constraints, assumptions, and criteria. Native-worktree execution is fixed
product policy, not a selectable Contract strategy.

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
- confirmation that the source repository can support a native worktree after
  approval.

Approval displays the exact Contract, material revision difference, fixed
worktree-only policy, verification commands, and the limit of ten remediation
rounds per batch. The initial verification is explicitly not a correction.

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
answer. Atomic approval changes `goals.state` from `AWAITING_APPROVAL` to
`PREPARING`; worktree creation cannot start before that commit.

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
authoritative goals.state
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

The common path grants Executor authority only for `EXECUTING` and Verifier
authority only for `VERIFYING`. Run records, dispatch status, pending
completion proposals, and pending verifier reports can narrow access but can
never grant it in another Goal state.

## 10. Persistence: Schema v9

Schema v9 is created and validated as one exact schema. It is an intentional
reset: old versions are not detected-and-upgraded and no migration path is
provided. A mismatch fails startup without modifying the database and tells the
operator to move aside or remove the incompatible local database before Goat
creates a new v9 database.

Tables:

| Table | Purpose |
| --- | --- |
| `goals` | Source request, root identity, model, authoritative `state`, `resume_state`, revision, and blocker |
| `contract_revisions` | Immutable Contract body and hash |
| `approval_attempts` | Approval generations, payload, binding, answer, and expiry |
| `acceptance_criteria` | Immutable criteria belonging to a revision |
| `runs` | Approved revision/worktree identity, baselines, Session references, remediation counters, finalization operation keys, and terminal reasons; no `state` column |
| `dispatches` | Durable prompts with stable message IDs and delivery state |
| `evidence` | Immutable criterion evidence |
| `verification_results` | Per-attempt findings and derived outcome |
| `session_bindings` | Active and revoked Executor/Verifier bindings |
| `leases` | Fenced Goal ownership |
| `audit_events` | Append-only critical history |

Schema v9 keeps the schema small. `goals.state` is the sole lifecycle marker;
`runs` cannot duplicate or override it. Persisted operation keys, snapshots,
reports, dispatches, bindings, and counters make idle-triggered finalization
and recovery idempotent without a second state machine. A separate check-run,
verification-batch, receipt, or finalization table is not required.

Integrity rules include foreign keys, immutable revision and evidence records,
typed JSON codecs, strict payload limits, canonical hashes, legal dispatch
compare-and-set transitions, and recomputed workspace digests.

## 11. Workspace Safety

- Execution is native-worktree-only.
- Goat creates or activates the worktree only in `PREPARING`, after exact
  approval is durable.
- The source checkout is read-only and never serves as an execution fallback.
- Native worktrees are checked against Git common directory and real path.
- `.git`, git-dir, git-common-dir, ignored targets, and path escapes are denied
  for direct file tools.
- Windows roots, UNC paths, POSIX paths, case behavior, Unicode, and legal
  filenames are handled according to the host platform.
- Add, update, delete, and move patch destinations are all validated.
- Symlink, junction, and reparse-point escapes fail closed.
- The source repository must be clean before approval and is revalidated before
  worktree preparation.
- Worktrees are preserved after completion, cancellation, and revision.
- Goat never automatically commits, merges, pushes, or deletes a worktree.

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
`SUPERSEDED`. A Session idle event starts reconciliation only when a matching
durable completion proposal or verifier report exists. Idle never independently
implies completion or continuation, and there is no generic retry scheduler.

Recovery runs at startup, after relevant events including Session idle, and on
explicit `/goat resume`. It acquires a Goal lease first, reloads durable state,
validates the persisted directory, and performs one fenced action at a time. It
never uses the current plugin directory as an implicit substitute.

Recovery covers missing Questions, uncertain prompts, worktree preparation,
child Session replacement, missing worktrees, pending completion proposals and
verification reports, stale leases, paused checkpoints, and finalization after
interruption. It never repeats an uncertain external side effect without
stable-message, operation-key, or identity reconciliation. Recovery may observe
that a Session is already idle and run the same event reconciliation, but a
completion/report tool never performs that wait itself.

## 13. Remediation Batches

The first verification after the approved execution is the initial
verification. It has remediation round `0` and is not a correction.

```text
initial execution -> initial verification
failed verification -> remediation 1 -> verification
failed verification -> remediation 2 -> verification
...
failed verification -> remediation 10 -> verification
```

The verifier derives the outcome:

- `PASS`: every MUST passes with valid evidence;
- `FAIL`: at least one MUST fails;
- `ERROR`: a technical or permission failure prevented a complete check;
- `PENDING`: no report has been committed yet.

Only `PASS` may finish the Goal. After `FAIL` or a remediable `ERROR`, finalized
findings return through `PREPARING` to an Executor for the next remediation
round. Each remediation round consists of one correction attempt followed by a
new independent verification. A batch allows at most ten remediation rounds;
the initial verification consumes none of them. No-progress detection is shown
for diagnosis but never silently changes this approved limit.

If verification after remediation round 10 still does not pass, the Goal
becomes `BLOCKED` with `resume_state` routing to the next remediation batch.
`/goat resume` explicitly opens that batch and resets its remediation counter.
Process failure, database failure, lost lease, or incomplete finalization does
not invent or consume a remediation round.

Every verification attempt receives a new Verifier Session. Prior evidence and
findings remain immutable. Remediation dispatches carry the exact persisted
findings to the Executor. A technical or non-remediable condition may block
with a phase-specific `resume_state` rather than pretending that a correction
occurred.

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

Concise status includes actual phase, worktree, MUST coverage, delivery and
Session condition, initial-verification or remediation batch/round position,
and one next action. Detailed status includes
Contract assumptions, verification commands, evidence references, findings,
approval expiry, model, timestamps, and preserved worktree. Internal IDs and
error codes stay out of normal output.

Every user-facing error says what happened, what was preserved, and what to do
next.

## 15. Testing and Release

Release gates are mandatory, not best-effort. The candidate must pass on Ubuntu,
Windows, and macOS: frozen install, typecheck/tests, the coverage gate, build,
and package smoke. The same packed candidate must then pass package-root
OpenCode load and an authenticated worktree workflow smoke against both the
minimum supported CLI and `latest`. A release must not be published when a gate
is skipped, unavailable, or failing.

Tests must cover:

- native path and Git metadata boundaries;
- reserved-agent and native permission composition;
- multi-worktree context isolation;
- lease takeover and await-time races;
- approval and dispatch crash windows;
- Executor and Verifier interruption;
- initial verification without consuming a remediation round;
- ten remediation failures/errors and a tenth-remediation pass;
- a second ten-remediation batch selected through `resume_state`;
- authority closure before finalization and pause checkpointing;
- idle-triggered handoffs, tool return without waiting/interruption, and restart
  reconciliation;
- real file-backed SQLite and concurrent initialization;
- native-worktree-only end-to-end flows and source-checkout write denial;
- package installation through `exports["./server"]`.

Release is tag-driven. Package version, changelog version, and tag must agree.
One candidate tarball and digest are used for package smoke, OpenCode smoke, and
npm publication. Prereleases use `alpha`, `beta`, or `rc`; `latest` is reserved
for stable releases. npm OIDC Trusted Publishing and provenance are required.
After publication, maintainers verify the registry version, integrity, package
contents, export, provenance, and dist-tag before announcing the release.

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
runs.state or any second lifecycle authority
Contract permission languages
capability grants or challenges
durable Decision Cards
generic child-task orchestration
isolated-copy workspace mode
source-checkout execution
automatic worktree cleanup
idle continuation scheduler
generic goat_transition
model-visible completion transition
duplicate source/criteria representations
path-only Executor attribution
unbound reserved-agent access
automatic seven/eight-attempt authorization
counting initial verification as a remediation round
```

These removals are deliberate. They reduce the number of independent state
machines while preserving the safety properties that users can understand and
test.
