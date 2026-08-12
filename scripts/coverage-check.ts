import { spawnSync } from "node:child_process";

const minimumLines = 85;
const stripAnsi = (value: string): string => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
const result = spawnSync("bun", ["test", "--coverage", "--coverage-reporter=text"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`);
const exitCode = result.status ?? 1;
process.stdout.write(output);
const diagnostic = output.trim().slice(-6_000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const reportDiagnostic = (): void => {
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Coverage diagnostics::${diagnostic}\n`);
};
const match = output.match(/All files\s+\|\s+[\d.]+\s+\|\s+([\d.]+)\s+\|/);
if (!match) {
  reportDiagnostic();
  throw new Error("coverage summary was not found");
}
if (exitCode !== 0 && !/\b0 fail\b/.test(output)) {
  reportDiagnostic();
  process.exit(exitCode);
}
const lines = Number(match[1]);
if (!Number.isFinite(lines) || lines < minimumLines) throw new Error(`line coverage ${lines}% is below required ${minimumLines}%`);
