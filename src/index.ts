import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { join } from "node:path";
import { createOpenCodeAdapters } from "./opencode/adapter.js";
import { createHooks } from "./opencode/hooks.js";
import { prepareDataHome, resolveDataHome } from "./runtime/data-home.js";
import { openDatabase } from "./store/database.js";
import { initializeSchema } from "./store/schema.js";
import { Store } from "./store/store.js";
import { systemClock } from "./core/ports.js";
import { cryptoIDGenerator } from "./core/ports.js";
import { Orchestrator } from "./runtime/orchestrator.js";
import { ProcessContext } from "./runtime/process-context.js";
import { createStateTool } from "./tools/state.js";
import { createContractProposeTool } from "./tools/contract-propose.js";
import { createEvidenceRecordTool } from "./tools/evidence-record.js";
import { createCompletionProposeTool } from "./tools/completion-propose.js";
import { createBlockTool } from "./tools/block.js";
import { createVerifierReportTool } from "./tools/verifier-report.js";

export const server: Plugin = async (input) => {
  const platform = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux" ? process.platform : "linux";
  const home = resolveDataHome(platform, process.env);
   const prepared = await prepareDataHome(home);
   if (!prepared.ok) throw new Error(`Goat data home is not ready: ${prepared.code}`);
  const projectId = input.project.id;
  const projectDirectory = input.directory;
  const worktreeOrigin = input.worktree;
   const adapters = createOpenCodeAdapters(input, platform);
   const context = await ProcessContext.acquire(prepared.path, projectId, () => {
     const db = openDatabase(join(prepared.path, "goat.db"));
     try {
       initializeSchema(db);
       const instanceId = cryptoIDGenerator.next();
       const store = new Store(db, systemClock, cryptoIDGenerator, instanceId);
       const orchestrator = new Orchestrator(store, adapters.session, adapters.workspace, adapters.question, projectId, adapters.toast, platform);
       return ProcessContext.create({ projectId, instanceId, db, store, orchestrator, releaseOwnedLeases: () => store.releaseOwnedLeases() });
     } catch (error) {
       db.close();
       throw error;
     }
   });
   const hooks = createHooks(context.orchestrator, adapters.session, adapters.registry, { projectId, rootWorkspaceId: null, projectDirectory, worktreeOrigin }, () => context.scheduleRecovery());
  hooks.tool = {
    goat_state: createStateTool(context.orchestrator),
    goat_contract_propose: createContractProposeTool(context.orchestrator),
    goat_evidence_record: createEvidenceRecordTool(context.orchestrator),
    goat_completion_propose: createCompletionProposeTool(context.orchestrator),
    goat_block: createBlockTool(context.orchestrator),
    goat_verifier_report: createVerifierReportTool(context.orchestrator),
  };
   const originalDispose = hooks.dispose;
   let released = false;
   hooks.dispose = async () => {
     if (released) return;
     released = true;
     await originalDispose?.();
     await context.release(prepared.path);
  };
  return hooks;
};

const plugin: PluginModule = { id: "goat", server };
export default plugin;
