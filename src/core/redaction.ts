const SECRET_KEY = /(?:api[-_]?key|authorization|proxy-authorization|cookie|credential|password|secret|token|x-amz-(?:credential|signature))/i;
const SECRET_TEXT = /(?:\b(?:bearer|basic|digest|negotiate)\s+\S+|\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=]\s*\S+|(?:api[-_]?key|access_token|token|secret|password)\s*[:=]\s*\S+|(?:ghp|github_pat)_[a-zA-Z0-9_]{20,}|[?&](?:x-amz-(?:credential|signature)|access_token|api[_-]?key)=)/i;
const SENSITIVE_QUERY = /^(?:x-amz-(?:credential|signature)|access_token|api[_-]?key)$/i;
export const REDACTED = "[REDACTED]";
export type SafeDiagnosticPrimitive = null | boolean | number | string;
export interface SafeDiagnosticObject { readonly [key: string]: SafeDiagnosticValue; }
export type SafeDiagnosticValue = SafeDiagnosticPrimitive | readonly SafeDiagnosticValue[] | SafeDiagnosticObject;
type Budget = { nodes: number; chars: number; readonly maxNodes: number; readonly maxChars: number };

export function redact(value: unknown, key?: string): SafeDiagnosticValue {
  const budget: Budget = { nodes: 0, chars: 0, maxNodes: 200, maxChars: 4096 };
  const seen = new WeakSet<object>();
  const text = (value: string): string => {
    const remaining = budget.maxChars - budget.chars;
    if (remaining <= 0) return "";
    if (value.length <= remaining) { budget.chars += value.length; return value; }
    const marker = "[TRUNCATED:BUDGET]";
    const output = marker.slice(0, remaining);
    budget.chars = budget.maxChars;
    return output;
  };
  const sentinel = (value: string) => text(value);
  const visit = (item: unknown, name: string | undefined, depth: number): SafeDiagnosticValue => {
    if (++budget.nodes > budget.maxNodes || budget.chars >= budget.maxChars) return sentinel("[TRUNCATED:BUDGET]");
    if (depth > 8) return sentinel("[TRUNCATED:DEPTH]");
    if (name && SECRET_KEY.test(name)) return sentinel(REDACTED);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : sentinel("[UNSAFE_NUMBER]");
    if (typeof item === "string") {
      if (SECRET_TEXT.test(item)) return sentinel(REDACTED);
      try { const url = new URL(item); if (url.username || url.password || [...url.searchParams.keys()].some((query) => SENSITIVE_QUERY.test(query))) return sentinel(REDACTED); } catch { /* ordinary text */ }
      return text(item);
    }
    if (typeof item !== "object" || item === undefined) return sentinel("[UNSAFE_VALUE]");
    if (seen.has(item)) return sentinel("[TRUNCATED:CYCLE]");
    seen.add(item);
    if (Array.isArray(item)) {
      const output: SafeDiagnosticValue[] = [];
      for (const child of item) { const next = visit(child, undefined, depth + 1); output.push(next); if (budget.chars >= budget.maxChars) break; }
      return output;
    }
    const output: Record<string, SafeDiagnosticValue> = {};
    for (const [childName, child] of Object.entries(item as Record<string, unknown>)) {
      // Keys are diagnostic content too; never leak an unbounded raw key.
      const safeName = text(childName);
      if (!safeName) break;
      const next = visit(child, childName, depth + 1);
      output[safeName] = next;
      if (budget.chars >= budget.maxChars) break;
    }
    return output;
  };
  return visit(value, key, 0);
}
