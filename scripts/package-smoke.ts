import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const root = process.cwd();

async function pack(): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["pm", "pack", "--no-progress"], { cwd: root, windowsHide: true, timeout: 120_000 });
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; version: string };
  const candidate = join(root, `${manifest.name}-${manifest.version}.tgz`);
  try {
    await readFile(candidate);
    return candidate;
  } catch {
    throw new Error(`cannot find packed tarball at ${candidate}; pack output: ${stdout.trim().split(/\r?\n/).at(-1) ?? "none"}`);
  }
}

async function candidateTarball(): Promise<{ path: string; owned: boolean }> {
  const supplied = process.env.GOAT_PACKAGE_SMOKE_TARBALL;
  if (supplied) {
    await readFile(supplied);
    return { path: supplied, owned: false };
  }
  return { path: await pack(), owned: true };
}

const allowed = new Set([
  "package.json",
   "README.md",
   "README.zh-CN.md",
  "LICENSE",
   "RELEASING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "assets/README.md",
  "assets/brand/goat-mark.svg",
  "assets/brand/goat-wordmark.svg",
  "assets/readme/hero.svg",
  "assets/readme/hero.zh-CN.svg",
  "assets/readme/workflow.svg",
  "assets/readme/workflow.zh-CN.svg",
  "assets/social/github-social-preview.svg",
  "assets/social/github-social-preview.png",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/core/canonical.js",
  "dist/core/canonical.d.ts",
  "dist/core/contract.js",
  "dist/core/contract.d.ts",
  "dist/core/errors.js",
  "dist/core/errors.d.ts",
  "dist/core/evidence.js",
  "dist/core/evidence.d.ts",
  "dist/core/ports.js",
  "dist/core/ports.d.ts",
  "dist/core/question.js",
  "dist/core/question.d.ts",
  "dist/core/redaction.js",
  "dist/core/redaction.d.ts",
   "dist/core/role-capabilities.js",
   "dist/core/role-capabilities.d.ts",
   "dist/core/session.js",
   "dist/core/session.d.ts",
   "dist/core/state.js",
  "dist/core/state.d.ts",
  "dist/core/workspace.js",
  "dist/core/workspace.d.ts",
  "dist/opencode/adapter.js",
  "dist/opencode/adapter.d.ts",
  "dist/opencode/commands.js",
  "dist/opencode/commands.d.ts",
  "dist/opencode/config.js",
  "dist/opencode/config.d.ts",
  "dist/opencode/hooks.js",
  "dist/opencode/hooks.d.ts",
  "dist/opencode/prompts.js",
  "dist/opencode/prompts.d.ts",
  "dist/presentation.js",
  "dist/presentation.d.ts",
  "dist/runtime/data-home.js",
  "dist/runtime/data-home.d.ts",
  "dist/runtime/orchestrator.js",
  "dist/runtime/orchestrator.d.ts",
  "dist/runtime/process-context.js",
  "dist/runtime/process-context.d.ts",
  "dist/store/database.js",
  "dist/store/database.d.ts",
  "dist/store/schema.js",
  "dist/store/schema.d.ts",
  "dist/store/store.js",
  "dist/store/store.d.ts",
  "dist/tools/block.js",
  "dist/tools/block.d.ts",
  "dist/tools/completion-propose.js",
  "dist/tools/completion-propose.d.ts",
  "dist/tools/contract-propose.js",
  "dist/tools/contract-propose.d.ts",
  "dist/tools/deps.js",
  "dist/tools/deps.d.ts",
  "dist/tools/evidence-record.js",
  "dist/tools/evidence-record.d.ts",
  "dist/tools/state.js",
  "dist/tools/state.d.ts",
  "dist/tools/verifier-report.js",
  "dist/tools/verifier-report.d.ts",
]);

async function listFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(path, relative));
    else files.push(relative);
  }
  return files;
}



async function main(): Promise<void> {
  const candidate = await candidateTarball();
  const tarball = candidate.path;
  try {
    const temp = await mkdtemp(join(tmpdir(), "goat-package-smoke-"));
    try {
      const project = join(temp, "project");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "package.json"), JSON.stringify({ name: "goat-package-smoke", private: true, type: "module" }, null, 2), "utf8");
      await execFileAsync(process.execPath, ["install", tarball], { cwd: project, windowsHide: true, timeout: 120_000 });
      const installed = join(project, "node_modules", "opencode-goat");
      await writeFile(join(project, "import.mjs"), "const mod = await import('opencode-goat/server'); if (mod.default?.id !== 'goat' || typeof mod.server !== 'function') process.exit(1);\n", "utf8");
      await execFileAsync(process.execPath, ["run", "import.mjs"], { cwd: project, windowsHide: true, timeout: 120_000 });
      const files = (await listFiles(installed, ".")).map((file) => file.replace(/^\.\//, ""));
      const unexpected = files.filter((file) => !allowed.has(file));
      if (unexpected.length > 0) throw new Error(`unexpected packaged files: ${unexpected.join(", ")}`);
      const missing = [...allowed].filter((file) => !files.includes(file));
      if (missing.length > 0) throw new Error(`missing packaged files: ${missing.join(", ")}`);
      for (const file of [...allowed].filter((value) => value.endsWith(".svg"))) {
        const svg = await readFile(join(installed, file), "utf8");
        if (!svg.includes("<svg") || /<script|(?:href|xlink:href)=["']https?:\/\//i.test(svg)) throw new Error(`unsafe visual asset: ${file}`);
      }
      const preview = await readFile(join(installed, "assets/social/github-social-preview.png"));
      if (preview.length >= 1_000_000 || preview.readUInt32BE(16) !== 1280 || preview.readUInt32BE(20) !== 640) throw new Error("social preview must be a 1280x640 PNG under 1 MB");
       const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as { name: string; version: string; engines?: { opencode?: string }; dependencies?: Record<string, string> };
       if (manifest.name !== "opencode-goat") throw new Error("packaged package name mismatch");
       if (manifest.engines?.opencode !== ">=1.18.15") throw new Error(`packaged OpenCode engine mismatch: ${manifest.engines?.opencode ?? "missing"}`);
       if (manifest.dependencies?.["@opencode-ai/plugin"] !== "1.18.15") throw new Error("packaged plugin dependency is not pinned to 1.18.15");
       if (manifest.dependencies?.["@opencode-ai/sdk"] !== "1.18.15") throw new Error("packaged SDK dependency is not pinned to 1.18.15");
       if (!Bun.semver.satisfies("1.18.15", manifest.engines.opencode) || Bun.semver.satisfies("1.18.14", manifest.engines.opencode)) throw new Error("packaged OpenCode engine range is invalid");
      const module = await import(pathToFileURL(join(installed, "dist", "index.js")).href) as { default?: { id?: string }; server?: unknown };
      if (module.default?.id !== "goat" || typeof module.server !== "function") throw new Error("packaged export surface mismatch");
      const sourceChecksum = createHash("sha256").update(await readFile(join(root, "dist", "index.js"))).digest("hex");
      const packagedChecksum = createHash("sha256").update(await readFile(join(installed, "dist", "index.js"))).digest("hex");
      if (sourceChecksum !== packagedChecksum) throw new Error("packaged dist differs from source dist");
      console.log(`package smoke passed: ${manifest.name}@${manifest.version} (${tarball})`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } finally {
    if (candidate.owned) await rm(tarball, { force: true });
  }
}

await main();
