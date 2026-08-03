const minimumLines = 85;
const result = Bun.spawnSync({ cmd: [process.execPath, "test", "--coverage"], stdout: "pipe", stderr: "pipe" });
const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
process.stdout.write(output);
if (result.exitCode !== 0) process.exit(result.exitCode);
const match = output.match(/All files\s+\|\s+[\d.]+\s+\|\s+([\d.]+)\s+\|/);
if (!match) throw new Error("coverage summary was not found");
const lines = Number(match[1]);
if (!Number.isFinite(lines) || lines < minimumLines) throw new Error(`line coverage ${lines}% is below required ${minimumLines}%`);
