import { DEFAULT_MAX_VERIFICATION_ATTEMPTS } from "./core/state.js";
import type { StatusReadModel } from "./runtime/orchestrator.js";

export function renderConcise(model: StatusReadModel): string {
  const goal = model.goal;
  const revision = model.revision;
  const run = model.run;
  const must = revision?.criteria.filter((criterion) => criterion.priority === "must") ?? [];
  const covered = new Set(model.evidence.map((item) => item.criterionId));
  return [
    `Goat: ${titleCase(goal.state)}`,
    `Outcome: ${revision?.body.outcome ?? goal.sourceRequest}`,
    `Workspace: ${run?.workspacePath ?? revision?.body.workspace ?? "not selected"}`,
    `Evidence: ${must.filter((criterion) => covered.has(criterion.id)).length}/${must.length} MUST criteria covered`,
    `Waiting: ${waitingReason(goal)}`,
    ...(goal.formationRequest ? [`Formation request: ${goal.formationRequest}`] : []),
    `Next: ${nextAction(goal.state)}`,
  ].join("\n");
}

export function renderDetailed(model: StatusReadModel): string {
  const concise = renderConcise(model);
  const revision = model.revision;
  if (!revision) return concise;
  const run = model.run;
  return [
    concise,
    "",
    "Contract:",
    `Outcome: ${revision.body.outcome}`,
    `Included: ${revision.body.scope.included.join("; ")}`,
    `Excluded: ${revision.body.scope.excluded.length ? revision.body.scope.excluded.join("; ") : "None"}`,
    `Constraints: ${revision.body.constraints.length ? revision.body.constraints.join("; ") : "None"}`,
    `Workspace: ${revision.body.workspace}`,
    "",
    "Criteria and evidence:",
    ...revision.criteria.map((criterion) => {
      const records = model.evidence.filter((item) => item.criterionId === criterion.id);
      return `- [${criterion.priority.toUpperCase()}] ${criterion.description}: ${records.length ? `${records.length} evidence record(s)` : "no evidence"}`;
    }),
    "",
    `Verification attempts: ${Math.min(model.results.length, DEFAULT_MAX_VERIFICATION_ATTEMPTS)}/${DEFAULT_MAX_VERIFICATION_ATTEMPTS}${model.results.length > DEFAULT_MAX_VERIFICATION_ATTEMPTS ? ` + ${model.results.length - DEFAULT_MAX_VERIFICATION_ATTEMPTS} authorized` : ""}`,
    ...model.results.map((result) => `- Attempt ${result.attempt}: ${result.outcome}`),
    "",
    "Recent activity:",
    ...model.audit.map((event) => `- ${event.kind}${event.previousState && event.nextState ? ` (${event.previousState} -> ${event.nextState})` : ""}`),
    ...(run?.checkpoint ? [`Checkpoint: ${run.checkpoint.head.slice(0, 12)}`] : []),
  ].join("\n");
}

export function renderBlocked(model: StatusReadModel): string {
  const goal = model.goal;
  const run = model.run;
  const preserved = run?.workspacePath ? `workspace at ${run.workspacePath}, recorded evidence, and verification history` : "the approved Contract and recorded history; no execution workspace was activated";
  const next = goal.blockerCode === "approval-not-approved"
    ? "Run /goat resume to ask for approval again, /goat revise <change> to change the Contract, or /goat cancel to end the Goal."
    : "Resolve the blocker, then run /goat resume; use /goat revise <change> if the Contract must change.";
  return [
    renderConcise(model),
    "",
    `What failed: ${goal.blocker ?? "The workflow cannot continue safely."}`,
    `Preserved: ${preserved}.`,
    `Next action: ${next}`,
  ].join("\n");
}

export function renderCompleted(model: StatusReadModel): string {
  const revision = model.revision;
  const latest = model.results.at(-1);
  return [
    renderConcise(model),
    "",
    "Independent verification:",
    ...(revision?.criteria.map((criterion) => {
      const finding = latest?.findings.find((item) => item.criterionId === criterion.id);
      return `- [${criterion.priority.toUpperCase()}] ${criterion.description}: ${finding?.result ?? "not reported"}${finding?.note ? ` - ${finding.note}` : ""}`;
    }) ?? ["- No Contract revision available"]),
    `Preserved workspace: ${model.run?.workspacePath ?? "none"}`,
  ].join("\n");
}

export function renderHelp(): string {
  return "Usage: /goat <intent>, /goat status, /goat pause, /goat resume, /goat revise <change>, /goat cancel, /goat help";
}

function waitingReason(goal: { state: string; blocker: string | null }): string {
  if (goal.state === "AWAITING_APPROVAL") return "Contract approval";
  if (goal.state === "BLOCKED") return goal.blocker ?? "user action";
  if (goal.state === "PAUSED") return "user resume";
  if (goal.state === "VERIFYING") return "independent Verifier";
  return "none";
}

function titleCase(value: string): string { return value.charAt(0) + value.slice(1).toLowerCase(); }
function nextAction(state: string): string {
  return state === "FORMING" ? "Formulator is discovering"
    : state === "AWAITING_APPROVAL" ? "Approve, revise, or cancel the Contract"
      : state === "ACTIVE" ? "Executor is working"
        : state === "VERIFYING" ? "Independent verification is running"
          : state === "PAUSED" ? "Resume when ready"
            : state === "BLOCKED" ? "Resolve the blocker and resume"
              : state === "COMPLETED" ? "Completed"
                : "No further action";
}
