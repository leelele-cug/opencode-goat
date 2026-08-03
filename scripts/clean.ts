import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

try {
  await rm(dist, { recursive: true, force: true });
  console.log("cleaned dist");
} catch (error) {
  console.error("clean failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
