import { createHash } from "node:crypto";

export const CANONICAL_SCHEMA_VERSION = "goat-canonical-json-v1";

function fail(message: string): never {
  throw new TypeError(`Cannot canonicalize value: ${message}`);
}

function serialize(value: unknown, inArray = false): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("number must be finite");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "undefined") fail(inArray ? "undefined array member" : "undefined object property");
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") fail(`unsupported ${typeof value}`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) if (!(index in value)) fail("sparse array");
    return `[${value.map((item) => serialize(item, true)).join(",")}]`;
  }
  if (typeof value !== "object") fail(`unsupported ${typeof value}`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("non-plain object");
  if (Object.getOwnPropertySymbols(value).length) fail("symbol-keyed property");
  const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) fail(`undefined object property ${key}`);
    return `${JSON.stringify(key)}:${serialize(item)}`;
  });
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serialize({ schemaVersion: CANONICAL_SCHEMA_VERSION, value });
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
