import { spawnSync } from "node:child_process";

const minimumLines = 85;
const stripAnsi = (value: string): string => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
const result = spawnSync(process.execPath, ["test", "--coverage", "--coverage-reporter=text"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
let output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
const exitCode = result.status ?? 1;
output = stripAnsi(output);
process.stdout.write(output);
const reportDiagnostic = (): void => {
  const diagnostic = output.trim().slice(-6_000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stderr.write(`Coverage diagnostics:\n${output.trim().slice(-6_000)}\n`);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Coverage diagnostics::${diagnostic}\n`);
};
if (exitCode !== 0) {
  reportDiagnostic();
  process.exit(exitCode);
}
const coverageLine = output.split(/\r?\n/).find((line) => /\bAll files\b/.test(line));
const textMatch = coverageLine?.match(/All files\s*\|\s*[\d.]+\s*\|\s*([\d.]+)/);
const lines = Number(textMatch?.[1]);
if (!Number.isFinite(lines)) {
  reportDiagnostic();
  throw new Error("coverage summary was not found");
}
if (lines < minimumLines) {
  reportDiagnostic();
  throw new Error(`line coverage ${lines}% is below required ${minimumLines}%`);
}
