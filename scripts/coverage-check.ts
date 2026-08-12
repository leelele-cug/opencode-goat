const minimumLines = 85;
const result = Bun.spawnSync({ cmd: [process.execPath, "test", "--coverage", "--coverage-reporter=text"], stdout: "pipe", stderr: "pipe" });
const stripAnsi = (value: string): string => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
const output = stripAnsi(`${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`);
process.stdout.write(output);
const diagnostic = output.trim().slice(-6_000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const reportDiagnostic = (): void => {
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Coverage diagnostics::${diagnostic}\n`);
};
if (result.exitCode !== 0) {
  reportDiagnostic();
  process.exit(result.exitCode);
}
const match = output.match(/All files\s+\|\s+[\d.]+\s+\|\s+([\d.]+)\s+\|/);
if (!match) {
  reportDiagnostic();
  throw new Error("coverage summary was not found");
}
const lines = Number(match[1]);
if (!Number.isFinite(lines) || lines < minimumLines) throw new Error(`line coverage ${lines}% is below required ${minimumLines}%`);
