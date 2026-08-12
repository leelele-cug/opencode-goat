import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const minimumLines = 85;
const stripAnsi = (value: string): string => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
const reportPath = process.argv[2] ?? process.env.GOAT_COVERAGE_OUTPUT;
let output: string;
let exitCode: number;
if (reportPath) {
  output = readFileSync(reportPath, "utf8");
  exitCode = Number(process.env.GOAT_COVERAGE_EXIT_CODE ?? 0);
} else {
  const result = spawnSync("bun test --coverage", { cwd: process.cwd(), encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] });
  output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  exitCode = result.status ?? 1;
}
output = stripAnsi(output);
if (!reportPath) process.stdout.write(output);
const diagnostic = output.trim().slice(-6_000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const reportDiagnostic = (): void => {
  process.stderr.write(`Coverage diagnostics:\n${output.trim().slice(-6_000)}\n`);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Coverage diagnostics::${diagnostic}\n`);
};
if (exitCode !== 0) {
  reportDiagnostic();
  process.exit(exitCode);
}
const lcovLineTotals = [...output.matchAll(/^LF:(\d+)$/gm)].map((match) => Number(match[1]));
const lcovHitTotals = [...output.matchAll(/^LH:(\d+)$/gm)].map((match) => Number(match[1]));
const lcovLines = lcovLineTotals.reduce((total, value) => total + value, 0);
const lcovHits = lcovHitTotals.reduce((total, value) => total + value, 0);
const coverageLine = output.split(/\r?\n/).find((line) => /\bAll files\b/.test(line));
const textMatch = coverageLine?.match(/All files\s*\|\s*[\d.]+\s*\|\s*([\d.]+)/);
const lines = lcovLines > 0 ? (lcovHits / lcovLines) * 100 : Number(textMatch?.[1]);
if (!Number.isFinite(lines)) {
  reportDiagnostic();
  throw new Error("coverage summary was not found");
}
if (!Number.isFinite(lines) || lines < minimumLines) throw new Error(`line coverage ${lines}% is below required ${minimumLines}%`);
