import type { Roots } from "../core.js";

export const DIAGNOSTIC_SOURCE_LIMIT = 2 * 1024 * 1024;
export const DIAGNOSTIC_JSON_LIMIT = 4 * 1024 * 1024;
export class DiagnosticExportTooLarge extends Error {
  constructor() { super("Diagnostic export is too large. The limit is 2 MiB of source data and 4 MiB of JSON. Choose a smaller run."); }
}

/** Counts JSON bytes without constructing its serialized representation. Undefined members
 * are conservatively counted too. A node/depth bound also limits object/pretty-print overhead. */
export function jsonBudget(value: unknown, limit: number): number {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (++nodes > 50_000 || depth > 64) throw new DiagnosticExportTooLarge();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8") + 2;
      for (let i = 0; i < item.length; i++) {
        const c = item.charCodeAt(i);
        if (c === 34 || c === 92) bytes++;
        else if (c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 1 : 5;
        else if (c >= 0xd800 && c <= 0xdfff) bytes += 3; // conservative for lone surrogates
      }
    } else if (item && typeof item === "object") {
      const entries = Array.isArray(item) ? item.map((v) => [undefined, v] as const) : Object.entries(item);
      if (entries.length + nodes + stack.length > 50_000) throw new DiagnosticExportTooLarge();
      bytes += 2 + entries.length; // braces/brackets and commas
      for (const [key, child] of entries) {
        if (key !== undefined) { bytes++; stack.push({ value: key, depth: depth + 1 }); }
        stack.push({ value: child, depth: depth + 1 });
      }
    } else bytes += 24; // upper bound for JSON numbers, booleans and null
    if (bytes > limit) throw new DiagnosticExportTooLarge();
  }
  return bytes;
}

/** Read scalar SQL byte totals first, never SELECT * / hydrate blob contents to size a run.
 * Account for every blob occurrence (including a shared blob used repeatedly in one span). */
export function checkDiagnosticSource(roots: Roots, traceId: string): number {
  const db = roots.store.db;
  let bytes = 0;
  const add = (n: number) => { bytes += n; if (bytes > DIAGNOSTIC_SOURCE_LIMIT) throw new DiagnosticExportTooLarge(); };
  const total = (sql: string) => add((db.prepare(sql).get(traceId) as { bytes: number }).bytes);
  total(`SELECT COALESCE(SUM(2048 + ${["name", "status_message", "attributes", "events", "links", "extra"].map((k) => `COALESCE(length(CAST(${k} AS BLOB)),0)`).join(" + ")}),0) bytes FROM spans WHERE trace_id=?`);
  total(`SELECT COALESCE(SUM(length(CAST(r.json AS BLOB))+length(CAST(c.json AS BLOB))+1024),0) bytes
    FROM (SELECT DISTINCT resource_id,scope_id FROM spans WHERE trace_id=?) s JOIN resources r ON r.id=s.resource_id JOIN scopes c ON c.id=s.scope_id`);
  for (const [table, fields] of [
    ["runs", ["project", "workflow", "root_name", "termination_reason", "session_id"]],
    ["findings", ["check_id", "title", "evidence_span_ids", "detail", "model"]],
    ["decisions", ["check_id", "answer", "backend"]],
    ["explanations", ["cause", "fix", "evidence_span_ids", "model"]],
  ] as const) total(`SELECT COALESCE(SUM(512 + ${fields.map((k) => `COALESCE(length(CAST(${k} AS BLOB)),0)`).join(" + ")}),0) bytes FROM ${table} WHERE trace_id=?`);
  total(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))+length(CAST(check_ids AS BLOB))+512),0) bytes FROM plans WHERE id=(SELECT plan_id FROM runs WHERE trace_id=?)`);
  const sizes = new Map<string, number>();
  for (const field of ["attributes", "events"]) {
    const refs = db.prepare(`SELECT json_extract(j.value,'$.sha') sha, json_extract(j.value,'$.len') len
      FROM spans s,json_tree(s.${field}) j WHERE s.trace_id=? AND j.key='blobRef'`);
    for (const ref of refs.iterate(traceId) as Iterable<{ sha: string; len: number }>) {
      let size = sizes.get(ref.sha);
      if (size === undefined) { size = roots.store.blobs.sizeOf(ref.sha); sizes.set(ref.sha, size); }
      add(Math.max(size, ref.len));
    }
  }
  return bytes;
}
