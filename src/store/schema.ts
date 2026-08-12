import { createHash } from "node:crypto";
import type { DatabaseConnection } from "./database.js";

export const SCHEMA_VERSION = 8;
export const SCHEMA_APPLICATION_ID = 0x676F6174;

const GOAL_STATES = "'FORMING','AWAITING_APPROVAL','ACTIVE','VERIFYING','PAUSED','BLOCKED','COMPLETED','CANCELLED'";
const NON_TERMINAL_GOAL_STATES = "'FORMING','AWAITING_APPROVAL','ACTIVE','VERIFYING','PAUSED','BLOCKED'";
const RUN_STATUSES = "'PREPARING','ACTIVE','FINALIZING','VERIFYING','PAUSED','BLOCKED','COMPLETED','CANCELLED'";
const ACTIVE_RUN_STATUSES = "'PREPARING','ACTIVE','FINALIZING','VERIFYING','PAUSED','BLOCKED'";
const APPROVAL_STATUSES = "'PENDING','APPROVED','REVISED','CANCELLED','REJECTED','EXPIRED','INVALIDATED'";
const DISPATCH_STATUSES = "'PENDING','SENT','STARTED','COMPLETED','FAILED','SUPERSEDED'";
const DISPATCH_KINDS = "'approval-reissue','executor-initial','executor-remediation','executor-resume','verifier'";
const DISPATCH_ROLES = "'formulator','executor','verifier'";
const VERIFICATION_OUTCOMES = "'PENDING','PASS','FAIL','ERROR','BLOCKED'";
const BLOCKER_CODES = "'approval-not-approved','workspace-preparation-failed','workspace-head-changed','workspace-dirty-at-activation','workspace-concurrent-changes','workspace-comparison-invalid','workspace-changed-during-verification','verification-budget-exhausted','verification-failed','executor-prompt-rejected','verifier-prompt-rejected','multiple-matching-approval-questions','multiple-matching-executor-sessions','multiple-matching-verifier-sessions','multiple-stable-worktrees','resume-worktree-missing','run-workspace-missing','recovery-workspace-invalid','executor-session-mismatch','verifier-session-mismatch','dispatch-identity-mismatch','executor-session-ended','verifier-session-ended','session-error','executor-blocked','user-blocked'";

const MODEL_COLUMNS = "model_provider_id TEXT, model_id TEXT, model_variant TEXT";

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE goals (
    goal_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    root_workspace_id TEXT,
    project_directory TEXT NOT NULL,
    worktree_origin TEXT NOT NULL,
    source_request TEXT NOT NULL CHECK (length(trim(source_request)) > 0),
    formation_request TEXT,
    model_provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_variant TEXT,
    state TEXT NOT NULL CHECK (state IN (${GOAL_STATES})),
    current_revision INTEGER CHECK (current_revision IS NULL OR current_revision >= 0),
    approved_revision_hash TEXT,
    current_run_id TEXT,
    blocker_code TEXT CHECK (blocker_code IS NULL OR blocker_code IN (${BLOCKER_CODES})),
    blocker TEXT,
    state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (goal_id, root_session_id),
    FOREIGN KEY (goal_id, current_revision) REFERENCES contract_revisions(goal_id, revision) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (goal_id, current_revision, approved_revision_hash) REFERENCES contract_revisions(goal_id, revision, hash) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (current_run_id, goal_id) REFERENCES runs(run_id, goal_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK (approved_revision_hash IS NULL OR current_revision IS NOT NULL),
    CHECK ((blocker_code IS NULL AND blocker IS NULL) OR (blocker_code IS NOT NULL AND blocker IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX goals_one_non_terminal_root
    ON goals(root_session_id)
    WHERE state IN (${NON_TERMINAL_GOAL_STATES})`,
  `CREATE INDEX goals_project_state ON goals(project_id, state, created_at)`,
  `CREATE TRIGGER goals_source_request_immutable BEFORE UPDATE OF source_request ON goals
    WHEN OLD.source_request IS NOT NEW.source_request
    BEGIN SELECT RAISE(ABORT, 'source request is immutable'); END`,
  `CREATE TRIGGER goals_identity_immutable BEFORE UPDATE OF project_id, root_session_id, project_directory, worktree_origin, created_at ON goals
    BEGIN SELECT RAISE(ABORT, 'goal identity is immutable'); END`,

  `CREATE TABLE contract_revisions (
    goal_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    body_json TEXT NOT NULL CHECK (json_valid(body_json)),
    hash TEXT NOT NULL CHECK (length(hash) = 64),
    operation_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (goal_id, revision),
    UNIQUE (goal_id, revision, hash),
    FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE RESTRICT
  )`,
  `CREATE TRIGGER contract_revisions_no_update BEFORE UPDATE ON contract_revisions
    BEGIN SELECT RAISE(ABORT, 'contract revisions are immutable'); END`,
  `CREATE TRIGGER contract_revisions_no_delete BEFORE DELETE ON contract_revisions
    BEGIN SELECT RAISE(ABORT, 'contract revisions are immutable'); END`,

  `CREATE TABLE approval_attempts (
    attempt_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    predecessor_attempt_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
    root_session_id TEXT NOT NULL,
    native_request_id TEXT,
    call_id TEXT,
    native_question_json TEXT NOT NULL CHECK (json_valid(native_question_json)),
    option_mapping_json TEXT NOT NULL CHECK (json_valid(option_mapping_json)),
    answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    preflight_snapshot_json TEXT CHECK (preflight_snapshot_json IS NULL OR json_valid(preflight_snapshot_json)),
    status TEXT NOT NULL CHECK (status IN (${APPROVAL_STATUSES})),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (attempt_id, goal_id, revision, contract_hash),
    UNIQUE (goal_id, generation),
    UNIQUE (goal_id, attempt_id),
    FOREIGN KEY (goal_id, revision, contract_hash) REFERENCES contract_revisions(goal_id, revision, hash) ON DELETE RESTRICT,
    FOREIGN KEY (goal_id, root_session_id) REFERENCES goals(goal_id, root_session_id) ON DELETE RESTRICT,
    FOREIGN KEY (predecessor_attempt_id) REFERENCES approval_attempts(attempt_id) ON DELETE RESTRICT,
    CHECK ((status = 'PENDING' AND resolved_at IS NULL) OR (status <> 'PENDING' AND resolved_at IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX approval_attempts_one_live
    ON approval_attempts(goal_id) WHERE status = 'PENDING'`,
  `CREATE TRIGGER approval_attempts_identity_immutable BEFORE UPDATE OF attempt_id,goal_id,generation,predecessor_attempt_id,revision,contract_hash,root_session_id,native_question_json,option_mapping_json,preflight_snapshot_json,created_at ON approval_attempts
    BEGIN SELECT RAISE(ABORT, 'approval attempt identity is immutable'); END`,

  `CREATE TABLE acceptance_criteria (
    criterion_row_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    criterion_id TEXT NOT NULL CHECK (length(trim(criterion_id)) > 0),
    priority TEXT NOT NULL CHECK (priority IN ('must','should')),
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
     verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
    UNIQUE (goal_id, revision, criterion_id),
    FOREIGN KEY (goal_id, revision) REFERENCES contract_revisions(goal_id, revision) ON DELETE RESTRICT
  )`,
  `CREATE TRIGGER acceptance_criteria_no_update BEFORE UPDATE ON acceptance_criteria
    BEGIN SELECT RAISE(ABORT, 'acceptance criteria are immutable'); END`,
  `CREATE TRIGGER acceptance_criteria_no_delete BEFORE DELETE ON acceptance_criteria
    BEGIN SELECT RAISE(ABORT, 'acceptance criteria are immutable'); END`,

  `CREATE TABLE runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    approval_attempt_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    approved_revision_hash TEXT NOT NULL CHECK (length(approved_revision_hash) = 64),
    workspace_strategy TEXT NOT NULL CHECK (workspace_strategy IN ('current','worktree')),
    worktree_name TEXT,
    workspace_path TEXT,
    baseline_json TEXT CHECK (baseline_json IS NULL OR json_valid(baseline_json)),
    checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
    final_snapshot_json TEXT CHECK (final_snapshot_json IS NULL OR json_valid(final_snapshot_json)),
    executor_diff_json TEXT CHECK (executor_diff_json IS NULL OR json_valid(executor_diff_json)),
    executor_session_id TEXT,
    executor_session_key TEXT NOT NULL CHECK (length(executor_session_key) > 0),
    executor_project_id TEXT,
    executor_workspace_id TEXT,
    ${MODEL_COLUMNS},
    status TEXT NOT NULL CHECK (status IN (${RUN_STATUSES})),
     verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
     verification_batch INTEGER NOT NULL DEFAULT 1 CHECK (verification_batch >= 1),
    preparation_retry_requested INTEGER NOT NULL DEFAULT 0 CHECK (preparation_retry_requested IN (0,1)),
    row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, goal_id),
    UNIQUE (run_id, goal_id, revision, approved_revision_hash),
    UNIQUE (goal_id, approval_attempt_id),
    FOREIGN KEY (goal_id, revision, approved_revision_hash) REFERENCES contract_revisions(goal_id, revision, hash) ON DELETE RESTRICT,
    FOREIGN KEY (goal_id, approval_attempt_id) REFERENCES approval_attempts(goal_id, attempt_id) ON DELETE RESTRICT,
    CHECK ((workspace_strategy = 'current' AND worktree_name IS NULL) OR workspace_strategy = 'worktree'),
    CHECK (model_provider_id IS NOT NULL AND model_id IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX runs_one_active_goal
    ON runs(goal_id) WHERE status IN (${ACTIVE_RUN_STATUSES})`,
  `CREATE UNIQUE INDEX runs_one_live_executor_session
    ON runs(executor_session_id) WHERE executor_session_id IS NOT NULL`,
  `CREATE UNIQUE INDEX runs_one_live_workspace
    ON runs(workspace_path) WHERE status IN (${ACTIVE_RUN_STATUSES}) AND workspace_path IS NOT NULL`,
  `CREATE INDEX runs_goal_revision ON runs(goal_id, revision, created_at)`,
  `CREATE TRIGGER runs_identity_immutable BEFORE UPDATE OF run_id, goal_id, approval_attempt_id, revision, approved_revision_hash, workspace_strategy, worktree_name, executor_session_key, model_provider_id, model_id, model_variant, created_at ON runs
    WHEN NEW.run_id IS NOT OLD.run_id OR NEW.goal_id IS NOT OLD.goal_id OR NEW.approval_attempt_id IS NOT OLD.approval_attempt_id OR NEW.revision IS NOT OLD.revision OR NEW.approved_revision_hash IS NOT OLD.approved_revision_hash OR NEW.workspace_strategy IS NOT OLD.workspace_strategy OR NEW.worktree_name IS NOT OLD.worktree_name OR NEW.executor_session_key IS NOT OLD.executor_session_key OR NEW.model_provider_id IS NOT OLD.model_provider_id OR NEW.model_id IS NOT OLD.model_id OR NEW.model_variant IS NOT OLD.model_variant OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'run identity is immutable'); END`,

  `CREATE TABLE dispatches (
    dispatch_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    run_id TEXT,
    approval_attempt_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
    kind TEXT NOT NULL CHECK (kind IN (${DISPATCH_KINDS})),
    role TEXT NOT NULL CHECK (role IN (${DISPATCH_ROLES})),
     verification_attempt INTEGER CHECK (verification_attempt IS NULL OR verification_attempt >= 1),
    target_session_id TEXT,
    directory TEXT,
    message_id TEXT UNIQUE NOT NULL CHECK (message_id GLOB 'msg_*'),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64),
    status TEXT NOT NULL CHECK (status IN (${DISPATCH_STATUSES})),
    failure_reason TEXT,
    row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (dispatch_id, goal_id, run_id, revision, contract_hash),
    FOREIGN KEY (goal_id, revision, contract_hash) REFERENCES contract_revisions(goal_id, revision, hash) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, goal_id, revision, contract_hash) REFERENCES runs(run_id, goal_id, revision, approved_revision_hash) ON DELETE RESTRICT,
    FOREIGN KEY (goal_id, approval_attempt_id) REFERENCES approval_attempts(goal_id, attempt_id) ON DELETE RESTRICT,
    CHECK (
      (kind = 'approval-reissue' AND run_id IS NULL AND role = 'formulator' AND verification_attempt IS NULL)
      OR (kind IN ('executor-initial','executor-remediation','executor-resume') AND run_id IS NOT NULL AND role = 'executor' AND verification_attempt IS NULL)
      OR (kind = 'verifier' AND run_id IS NOT NULL AND role = 'verifier' AND verification_attempt IS NOT NULL)
    ),
    CHECK (status IN (${DISPATCH_STATUSES}) AND (status IN ('PENDING','FAILED','SUPERSEDED') OR (target_session_id IS NOT NULL AND directory IS NOT NULL))),
    CHECK ((status IN ('FAILED','SUPERSEDED') AND failure_reason IS NOT NULL) OR (status NOT IN ('FAILED','SUPERSEDED') AND failure_reason IS NULL))
  )`,
  `CREATE UNIQUE INDEX dispatches_one_live_approval_reissue
    ON dispatches(goal_id, revision, kind) WHERE kind = 'approval-reissue' AND status IN ('PENDING','SENT','STARTED')`,
  `CREATE INDEX dispatches_goal_status ON dispatches(goal_id, status, created_at)`,
  `CREATE INDEX dispatches_run_kind ON dispatches(run_id, role, created_at)`,
  `CREATE TRIGGER dispatches_identity_immutable BEFORE UPDATE OF dispatch_id, goal_id, run_id, approval_attempt_id, revision, contract_hash, kind, role, verification_attempt, message_id, payload_json, prompt_hash, created_at ON dispatches
    BEGIN SELECT RAISE(ABORT, 'dispatch identity is immutable'); END`,

  `CREATE TABLE evidence (
    evidence_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
    criterion_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (length(trim(source)) > 0),
    method TEXT NOT NULL CHECK (length(trim(method)) > 0),
    expected_result TEXT NOT NULL CHECK (length(trim(expected_result)) > 0),
    actual_reference TEXT NOT NULL CHECK (length(trim(actual_reference)) > 0),
    producer TEXT NOT NULL CHECK (length(trim(producer)) > 0),
    operation_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (evidence_id, goal_id, run_id, revision, criterion_id),
    FOREIGN KEY (goal_id, revision, criterion_id) REFERENCES acceptance_criteria(goal_id, revision, criterion_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, goal_id, revision, contract_hash) REFERENCES runs(run_id, goal_id, revision, approved_revision_hash) ON DELETE RESTRICT
  )`,
  `CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
    BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END`,
  `CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
    BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END`,

  `CREATE TABLE verification_results (
    result_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
     attempt INTEGER NOT NULL CHECK (attempt >= 1),
    verifier_session_id TEXT,
    verifier_session_key TEXT,
    model_provider_id TEXT,
    model_id TEXT,
    model_variant TEXT,
    findings_json TEXT NOT NULL CHECK (json_valid(findings_json)),
    outcome TEXT NOT NULL CHECK (outcome IN (${VERIFICATION_OUTCOMES})),
    operation_key TEXT NOT NULL UNIQUE,
    dispatch_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    UNIQUE (run_id, attempt),
    UNIQUE (result_id, run_id, goal_id, revision, contract_hash),
    FOREIGN KEY (run_id, goal_id, revision, contract_hash) REFERENCES runs(run_id, goal_id, revision, approved_revision_hash) ON DELETE RESTRICT,
    FOREIGN KEY (dispatch_id) REFERENCES dispatches(dispatch_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CHECK ((outcome = 'PENDING' AND finalized_at IS NULL) OR (outcome <> 'PENDING' AND finalized_at IS NOT NULL)),
    CHECK ((model_provider_id IS NULL AND model_id IS NULL AND model_variant IS NULL) OR (model_provider_id IS NOT NULL AND model_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX verification_results_one_pending_verifier
    ON verification_results(verifier_session_id) WHERE outcome = 'PENDING' AND verifier_session_id IS NOT NULL`,
  `CREATE TRIGGER verification_results_legal_update BEFORE UPDATE ON verification_results
    WHEN NOT (
      (OLD.outcome = 'PENDING' AND NEW.outcome = 'PENDING' AND NEW.verifier_session_id IS NOT NULL AND OLD.verifier_session_id IS NOT NEW.verifier_session_id
        AND NEW.result_id = OLD.result_id AND NEW.goal_id = OLD.goal_id AND NEW.run_id = OLD.run_id AND NEW.revision = OLD.revision
        AND NEW.contract_hash = OLD.contract_hash AND NEW.attempt = OLD.attempt AND NEW.findings_json = OLD.findings_json
        AND NEW.model_provider_id IS OLD.model_provider_id AND NEW.model_id IS OLD.model_id AND NEW.model_variant IS OLD.model_variant
        AND NEW.created_at = OLD.created_at AND NEW.finalized_at IS NULL)
      OR
       (OLD.outcome = 'PENDING' AND NEW.outcome IN ('PASS','FAIL','ERROR','BLOCKED') AND NEW.finalized_at IS NOT NULL
        AND NEW.result_id = OLD.result_id AND NEW.goal_id = OLD.goal_id AND NEW.run_id = OLD.run_id AND NEW.revision = OLD.revision
        AND NEW.contract_hash = OLD.contract_hash AND NEW.attempt = OLD.attempt AND NEW.verifier_session_id = OLD.verifier_session_id
        AND NEW.verifier_session_key = OLD.verifier_session_key
        AND NEW.model_provider_id IS OLD.model_provider_id AND NEW.model_id IS OLD.model_id AND NEW.model_variant IS OLD.model_variant
        AND NEW.created_at = OLD.created_at)
    )
    BEGIN SELECT RAISE(ABORT, 'verification result update is not legal'); END`,
  `CREATE TRIGGER verification_results_no_delete BEFORE DELETE ON verification_results
    BEGIN SELECT RAISE(ABORT, 'verification results are immutable'); END`,

  `CREATE TABLE session_bindings (
    session_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('executor','verifier')),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, goal_id) REFERENCES runs(run_id, goal_id) ON DELETE RESTRICT,
    CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
  )`,
  `CREATE INDEX session_bindings_goal_run ON session_bindings(goal_id, run_id, status)`,
  `CREATE INDEX session_bindings_status ON session_bindings(session_id, status)`,

  `CREATE TABLE leases (
    goal_id TEXT PRIMARY KEY NOT NULL,
    fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
    holder_instance_id TEXT,
    expires_at TEXT,
    FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE RESTRICT,
    CHECK ((holder_instance_id IS NULL AND expires_at IS NULL) OR (holder_instance_id IS NOT NULL AND expires_at IS NOT NULL))
  )`,
  `CREATE TRIGGER leases_token_monotonic BEFORE UPDATE OF fencing_token ON leases
    WHEN NEW.fencing_token < OLD.fencing_token
    BEGIN SELECT RAISE(ABORT, 'fencing token must not decrease'); END`,

  `CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    goal_sequence INTEGER NOT NULL CHECK (goal_sequence >= 1),
    kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
    actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    previous_state TEXT CHECK (previous_state IS NULL OR previous_state IN (${GOAL_STATES})),
    next_state TEXT CHECK (next_state IS NULL OR next_state IN (${GOAL_STATES})),
    source_event_id TEXT,
    fencing_token INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (goal_id, goal_sequence),
    FOREIGN KEY (goal_id) REFERENCES goals(goal_id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX audit_events_goal_sequence ON audit_events(goal_id, goal_sequence)`,
  `CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`,
  `CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END`,
];

type SchemaObject = { readonly type: "table" | "index" | "trigger" | "view"; readonly name: string; readonly tableName: string; readonly sql: string };

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function expectedObject(sql: string): SchemaObject {
  const normalized = normalizeSql(sql);
  const match = /^CREATE\s+(?:(UNIQUE)\s+)?(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(normalized);
  if (!match?.[2] || !match[3]) throw new Error(`Cannot identify Goat schema object: ${normalized}`);
  const type = match[2].toLowerCase() as SchemaObject["type"];
  const tableMatch = type === "table"
    ? match[3]
    : /\sON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(normalized)?.[1];
  if (!tableMatch) throw new Error(`Cannot identify Goat schema owner: ${normalized}`);
  return { type, name: match[3], tableName: tableMatch, sql: normalized };
}

function schemaSignature(objects: readonly SchemaObject[]): string {
  const canonical = [...objects]
    .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))
    .map((object) => `${object.type}:${object.name}:${object.tableName}:${normalizeSql(object.sql)}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const EXPECTED_SCHEMA_OBJECTS = SCHEMA_DDL.map(expectedObject);
export const EXPECTED_SCHEMA_SIGNATURE = schemaSignature(EXPECTED_SCHEMA_OBJECTS);

/**
 * Reviewed golden signature for the approved Schema v8 release. Changing the
 * DDL without consciously updating this constant fails the schema tests.
 */
export const GOLDEN_SCHEMA_SIGNATURE = "1f37895dea514b32981488f8d6d0734c284e355ae7db03384920df2fc5b4ea52";

export function validateSchema(db: DatabaseConnection): void {
  const actualObjects = db.listSchemaObjects().map((object) => ({ ...object, sql: normalizeSql(object.sql) }));
  const actualSignature = schemaSignature(actualObjects);
  if (actualSignature !== GOLDEN_SCHEMA_SIGNATURE) {
    throw new Error(`Goat database schema ${SCHEMA_VERSION} is incompatible. Expected signature ${GOLDEN_SCHEMA_SIGNATURE}, received ${actualSignature}. Move the database aside and restart to create the approved schema.`);
  }
  const violations = db.foreignKeyViolations();
  if (violations.length > 0) throw new Error(`Goat database failed foreign_key_check with ${violations.length} violation(s).`);
  const integrity = db.integrityCheck();
  if (!integrity.ok) throw new Error(`Goat database failed integrity_check: ${integrity.message}`);
}

export function initializeSchema(db: DatabaseConnection): void {
  const version = db.getUserVersion();
  if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Goat database schema ${version} is incompatible with required schema ${SCHEMA_VERSION}. No automatic migration is available.`);
  if (version === 0) {
    if (db.hasUserSchemaObjects()) throw new Error("Goat database has schema objects but no recognized schema version. Refusing to modify it.");
    db.transaction(() => {
      if (db.getUserVersion() !== 0 || db.hasUserSchemaObjects()) throw new Error("Concurrent database initialization changed the database. Refusing to continue.");
      for (const statement of SCHEMA_DDL) db.run(statement);
      db.setApplicationId(SCHEMA_APPLICATION_ID);
      db.setUserVersion(SCHEMA_VERSION);
    }).immediate();
  }
  if (db.getApplicationId() !== SCHEMA_APPLICATION_ID) {
    throw new Error(`Goat database application id ${db.getApplicationId()} is incompatible with ${SCHEMA_APPLICATION_ID}. Refusing to modify it.`);
  }
  validateSchema(db);
  db.enableWal();
}
