import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Roots } from "../core.js";
import { isQuestion, type Check } from "../checks/types.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import { compileRules, redactBatches, redactString, type RedactionRule } from "../relay/redact.js";
import type { Finding } from "../types.js";
import { VERSION } from "../version.js";
import { err } from "./util.js";
import { checkDiagnosticSource, DIAGNOSTIC_JSON_LIMIT, DiagnosticExportTooLarge, DiagnosticRedactionBudget, jsonBudget } from "./diagnostic-export-budget.js";

const FORMAT = "neatroots.diagnostic-export";
const SCHEMA_VERSION = 1;

// These names describe the bundle and OTLP wire shape. Data map keys are still redacted.
const STRUCTURAL_KEYS = new Set([
  "format", "schema_version", "exported_at", "version", "neatroots", "run", "trace", "findings", "checks", "redactions", "applied",
  "rule_source", "scope", "matches", "kind", "count", "trace_id", "session_id", "project", "workflow",
  "root_span_id", "root_name", "status", "started_ms", "ended_ms", "span_count", "llm_calls", "tool_calls", "error_count",
  "prompt_tokens", "completion_tokens", "total_tokens", "input_preview", "output_preview", "interrupted", "termination_reason",
  "id", "check_id", "check_kind", "title", "probability", "evidence_span_ids", "detail", "model", "triage_score", "created_ms",
  "updated_ms", "explanation", "explanation_id", "cause", "fix", "grounding", "plan", "plan_available", "plan_id", "available",
  "recorded_check_ids", "historical_definitions", "definition_available", "note", "current_definitions", "source", "definition", "enabled_now", "currently_applicable_rule",
  "decisions", "span_id", "answer", "backend", "latency_ms", "resourceSpans", "resource", "scopeSpans", "spans", "attributes",
  "key", "value", "stringValue", "boolValue", "intValue", "doubleValue", "bytesValue", "arrayValue", "values", "kvlistValue",
  "droppedAttributesCount", "schemaUrl", "name", "scope", "traceId", "spanId", "parentSpanId", "traceState", "flags",
  "startTimeUnixNano", "endTimeUnixNano", "events", "droppedEventsCount", "links", "droppedLinksCount", "timeUnixNano", "code",
  "message", "description", "enabled", "baseline", "applies_to", "guidance", "tags", "group", "ask", "when", "params", "options",
  "flag_on", "flag_at", "levels", "flag_at_level", "rule", "type", "same", "at_least", "consecutive", "at_least_ms", "metric",
  "requires", "min_calls", "rising", "factor", "min_tokens", "max_period", "min_cycles", "goal", "final_output", "last", "fields",
  "tool", "start", "end", "duration_ms", "error", "input", "output", "tokens", "rootInput", "system", "user", "content", "role",
  "arguments", "state", "choice", "confidence", "score",
]);
export interface DiagnosticExportBundle {
  format: typeof FORMAT;
  schema_version: typeof SCHEMA_VERSION;
  exported_at: string;
  version: { neatroots: string };
  run: Record<string, unknown>;
  trace: { format: "otlp-json"; resourceSpans: unknown[] };
  findings: Record<string, unknown>[];
  checks: Record<string, unknown>;
  redactions: { applied: true; rule_source: "cloud_forwarding"; scope: string; matches: { kind: string; count: number }[] };
}

export interface DiagnosticExportResponse {
  bundle: DiagnosticExportBundle;
  preview: { span_count: number; finding_count: number; check_count: number };
}

function redactTree(value: unknown, rules: RedactionRule[], path: string, budget: DiagnosticRedactionBudget, safeAliases: Set<string>, depth = 0): unknown {
  budget.node(depth);
  if (typeof value === "string") return safeAliases.has(value) ? value : redactString(value, rules, "", [], budget);
  if (Array.isArray(value)) return value.map((item, index) => redactTree(item, rules, `${path}[${index}]`, budget, safeAliases, depth + 1));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let keyIndex = 0;
  for (const [key, item] of Object.entries(value)) {
    const proposed = safeAliases.has(key) || STRUCTURAL_KEYS.has(key) ? key : redactString(key, rules, "", [], budget);
    let safeKey = proposed;
    let collision = 1;
    while (Object.hasOwn(output, safeKey)) safeKey = `${proposed} [${++collision}]`;
    output[safeKey] = redactTree(item, rules, `${path}[${keyIndex++}]`, budget, safeAliases, depth + 1);
  }
  return output;
}

function otlpJson(batches: ResourceSpansBatch[]): { resourceSpans: unknown[] } {
  return {
    resourceSpans: batches.map(({ resource, scope, spans }) => {
      const { schemaUrl: resourceSchemaUrl, ...resourceData } = resource;
      const { schemaUrl: scopeSchemaUrl, ...scopeData } = scope;
      return {
        resource: resourceData,
        schemaUrl: resourceSchemaUrl,
        scopeSpans: [{ scope: scopeData, schemaUrl: scopeSchemaUrl, spans }],
      };
    }),
  };
}

export function createCheckAliases(ids: readonly string[], prefix: string): Map<string, string> {
  const occupied = new Set(ids);
  const aliases = new Map<string, string>();
  let ordinal = 0;
  for (const id of occupied) {
    let alias: string;
    do { alias = `${prefix}-${++ordinal}`; } while (occupied.has(alias));
    aliases.set(id, alias);
  }
  return aliases;
}

function exportCheck(check: Check, alias: string): Record<string, unknown> {
  if (!isQuestion(check)) return { ...check, id: alias, ...(check.title === check.id ? { title: alias } : {}) };
  // Planner/draft titles may be prefixes of ask with a credential delimiter lost.
  // Keep the full ask for redaction; do not infer a historical title from it.
  const { title: _title, ...definition } = check;
  return { ...definition, id: alias };
}

function exportFinding(roots: Roots, finding: Finding, alias: string): Record<string, unknown> {
  const explanation = finding.explanation_id ? roots.store.getExplanation(finding.explanation_id) : undefined;
  // Params, verification quotes and model-client error bodies can be clipped before storage. Their
  // missing delimiters/prefixes make pattern redaction unsafe. Keep the remaining
  // snapshot metadata; full evidence is available in the redacted trace instead.
  const { params: _params, quote: _quote, error: _error, ...detail } = finding.detail;
  return {
    id: finding.id,
    check_id: alias,
    check_kind: finding.check_kind,
    ...(finding.check_kind === "rule" ? { title: finding.title === finding.check_id ? alias : finding.title } : {}),
    probability: finding.probability,
    status: finding.status,
    evidence_span_ids: finding.evidence_span_ids,
    detail,
    model: finding.model,
    triage_score: finding.triage_score,
    created_ms: finding.created_ms,
    updated_ms: finding.updated_ms,
    explanation: explanation
      ? {
          // Investigations may echo clipped titles/evidence whose delimiters are already lost.
          // Export the supporting metadata, not prose that pattern matching cannot safely redact.
          evidence_span_ids: explanation.evidence_span_ids,
          grounding: explanation.grounding,
          model: explanation.model,
          created_ms: explanation.created_ms,
        }
      : null,
  };
}

export function prepareDiagnosticExport(roots: Roots, traceId: string): DiagnosticExportResponse | undefined {
  checkDiagnosticSource(roots, traceId);
  const run = roots.store.getRun(traceId);
  if (!run) return undefined;

  const findings = roots.store.findingsForTrace(traceId);
  const decisions = roots.store.decisionsForTrace(traceId);
  const plan = run.plan_id ? roots.store.getPlan(run.plan_id) : undefined;
  const enabledIds = new Set(roots.checks.enabled().map(({ check }) => check.id));
  const applicableRuleIds = new Set(
    roots.checks.rules()
      .filter(({ check }) => {
        const list = (value: string | string[] | undefined) => value === undefined ? undefined : Array.isArray(value) ? value : [value];
        const project = list(check.applies_to?.project);
        const workflow = list(check.applies_to?.workflow);
        return (!project || project.includes(run.project ?? "")) && (!workflow || workflow.includes(run.workflow ?? ""));
      })
      .map(({ check }) => check.id),
  );
  const relevantIds = [...new Set([
    ...findings.map((f) => f.check_id),
    ...decisions.map((d) => d.check_id),
    ...(plan?.check_ids ?? []),
    ...Object.keys(plan?.params ?? {}),
    ...applicableRuleIds,
  ])].sort();
  // No original-ID lookup table is exported: IDs can contain transformed credentials.
  const prefix = `check-${randomBytes(8).toString("hex")}`;
  const aliases = createCheckAliases(relevantIds, prefix);
  const currentDefinitions = relevantIds.map((id) => {
    const current = roots.checks.get(id);
    return {
      check_id: aliases.get(id)!,
      available: !!current,
      enabled_now: !!current && enabledIds.has(id),
      currently_applicable_rule: applicableRuleIds.has(id),
      source: current?.source ?? null,
      definition: current ? exportCheck(current.check, aliases.get(id)!) : null,
    };
  });

  const rawBatches = roots.store.batchesForTraces([traceId]);
  const rules = compileRules(roots.config.cloud.redactPatterns);
  const budget = new DiagnosticRedactionBudget();
  const trace = redactBatches(rawBatches, rules, budget);
  const exportedRun = {
    trace_id: run.trace_id,
    session_id: run.session_id,
    project: run.project,
    workflow: run.workflow,
    root_span_id: run.root_span_id,
    root_name: run.root_name,
    status: run.status,
    started_ms: run.started_ms,
    ended_ms: run.ended_ms,
    span_count: run.span_count,
    llm_calls: run.llm_calls,
    tool_calls: run.tool_calls,
    error_count: run.error_count,
    prompt_tokens: run.prompt_tokens,
    completion_tokens: run.completion_tokens,
    total_tokens: run.total_tokens,
    // Stored previews are truncated before redaction and can lose a credential's
    // closing delimiter. Export only the full, redacted values in trace instead.
    interrupted: !!run.interrupted,
    termination_reason: run.termination_reason,
  };
  const rawBundle = {
    format: "neatroots.diagnostic-export" as const,
    schema_version: 1 as const,
    exported_at: new Date().toISOString(),
    version: { neatroots: VERSION },
    run: exportedRun,
    trace: { format: "otlp-json" as const, ...otlpJson(trace.batches) },
    findings: findings.map((finding) => exportFinding(roots, finding, aliases.get(finding.check_id)!)),
    checks: {
      historical: {
        plan_available: !!plan,
        plan_id: plan?.id ?? null,
        recorded_check_ids: (plan?.check_ids ?? []).map((id) => aliases.get(id)!),
        params: Object.fromEntries(Object.entries(plan?.params ?? {}).map(([id, params]) => [aliases.get(id)!, params])),
        historical_definitions: "not-retained",
        note: plan
          ? "The saved run plan records check aliases and per-run parameters, not historical check definition bodies."
          : "No saved run plan is available; finding snapshots still identify checks that raised findings.",
      },
      current_definitions: currentDefinitions,
      decisions: decisions.map((decision) => ({
        check_id: aliases.get(decision.check_id)!,
        span_id: decision.span_id,
        probability: decision.probability,
        answer: decision.answer,
        backend: decision.backend,
        latency_ms: decision.latency_ms,
        created_ms: decision.created_ms,
      })),
    },
    redactions: {
      applied: true as const,
      rule_source: "cloud_forwarding" as const,
      scope: "Check IDs use consistent opaque aliases within this bundle. Existing built-in and configured custom cloud-forwarding patterns apply to other matching strings and non-structural keys. Stored run previews, question titles, finding parameters, verification quotes and finding error messages are omitted because already-clipped values cannot be reliably redacted. Investigation cause/fix prose is omitted because it may echo that clipped evidence. Explanation evidence IDs, grounding, model and timestamp remain. Full current questions and trace evidence are retained with redaction. This cannot guarantee every sensitive value is detected.",
      matches: [] as { kind: string; count: number }[],
    },
  };

  const sanitized = redactTree(rawBundle, rules, "bundle", budget, new Set(aliases.values())) as typeof rawBundle;
  sanitized.redactions.matches = [...budget.counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count }));

  const response = {
    bundle: sanitized,
    preview: {
      span_count: rawBatches.reduce((count, batch) => count + batch.spans.length, 0),
      finding_count: findings.length,
      check_count: relevantIds.length,
    },
  };
  jsonBudget(response, DIAGNOSTIC_JSON_LIMIT);
  return response;
}

export function mountDiagnosticExportApi(app: Hono, roots: Roots): void {
  app.get("/api/runs/:traceId/diagnostic-export", (c) => {
    c.header("Cache-Control", "no-store");
    let prepared: DiagnosticExportResponse | undefined;
    try { prepared = prepareDiagnosticExport(roots, c.req.param("traceId")); }
    catch (error) { if (error instanceof DiagnosticExportTooLarge) return err(c, 413, error.message); throw error; }
    if (!prepared) return err(c, 404, "run not found");
    c.header("Cache-Control", "no-store");
    return c.json(prepared);
  });
}
