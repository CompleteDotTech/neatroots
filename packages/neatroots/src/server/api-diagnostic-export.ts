import type { Hono } from "hono";
import type { Roots } from "../core.js";
import type { ResourceSpansBatch } from "../otlp/types.js";
import { compileRules, redactBatches, redactString, type RedactionHit, type RedactionRule } from "../relay/redact.js";
import type { Finding } from "../types.js";
import { VERSION } from "../version.js";
import { err } from "./util.js";

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

function redactTree(value: unknown, rules: RedactionRule[], path: string, hits: RedactionHit[]): unknown {
  if (typeof value === "string") return redactString(value, rules, path, hits);
  if (Array.isArray(value)) return value.map((item, index) => redactTree(item, rules, `${path}[${index}]`, hits));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let keyIndex = 0;
  for (const [key, item] of Object.entries(value)) {
    const proposed = STRUCTURAL_KEYS.has(key) ? key : redactString(key, rules, `${path}.key`, hits);
    let safeKey = proposed;
    let collision = 1;
    while (Object.hasOwn(output, safeKey)) safeKey = `${proposed} [${++collision}]`;
    output[safeKey] = redactTree(item, rules, `${path}[${keyIndex++}]`, hits);
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

function exportFinding(roots: Roots, finding: Finding): Record<string, unknown> {
  const explanation = finding.explanation_id ? roots.store.getExplanation(finding.explanation_id) : undefined;
  return {
    id: finding.id,
    check_id: finding.check_id,
    check_kind: finding.check_kind,
    title: finding.title,
    probability: finding.probability,
    status: finding.status,
    evidence_span_ids: finding.evidence_span_ids,
    detail: finding.detail,
    model: finding.model,
    triage_score: finding.triage_score,
    created_ms: finding.created_ms,
    updated_ms: finding.updated_ms,
    explanation: explanation
      ? {
          cause: explanation.cause,
          fix: explanation.fix,
          evidence_span_ids: explanation.evidence_span_ids,
          grounding: explanation.grounding,
          model: explanation.model,
          created_ms: explanation.created_ms,
        }
      : null,
  };
}

export function prepareDiagnosticExport(roots: Roots, traceId: string): DiagnosticExportResponse | undefined {
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
    ...applicableRuleIds,
  ])].sort();
  const currentDefinitions = relevantIds.map((id) => {
    const current = roots.checks.get(id);
    return {
      check_id: id,
      available: !!current,
      enabled_now: !!current && enabledIds.has(id),
      currently_applicable_rule: applicableRuleIds.has(id),
      source: current?.source ?? null,
      definition: current?.check ?? null,
    };
  });

  const rawBatches = roots.store.batchesForTraces([traceId]);
  const rules = compileRules(roots.config.cloud.redactPatterns);
  const trace = redactBatches(rawBatches, rules);
  const hits = [...trace.hits];
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
    findings: findings.map((finding) => exportFinding(roots, finding)),
    checks: {
      historical: {
        plan_available: !!plan,
        plan_id: plan?.id ?? null,
        recorded_check_ids: plan?.check_ids ?? [],
        historical_definitions: "not-retained",
        note: plan
          ? "The saved run plan records check IDs, not historical check definition bodies."
          : "No saved run plan is available; finding snapshots still identify checks that raised findings.",
      },
      current_definitions: currentDefinitions,
      decisions: decisions.map((decision) => ({
        check_id: decision.check_id,
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
      scope: "Existing built-in and configured custom cloud-forwarding patterns are applied to matching strings and non-structural keys. This cannot guarantee every sensitive value is detected.",
      matches: [] as { kind: string; count: number }[],
    },
  };

  const sanitized = redactTree(rawBundle, rules, "bundle", hits) as typeof rawBundle;
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + 1);
  sanitized.redactions.matches = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count }));

  return {
    bundle: sanitized,
    preview: {
      span_count: rawBatches.reduce((count, batch) => count + batch.spans.length, 0),
      finding_count: findings.length,
      check_count: relevantIds.length,
    },
  };
}

export function mountDiagnosticExportApi(app: Hono, roots: Roots): void {
  app.get("/api/runs/:traceId/diagnostic-export", (c) => {
    const prepared = prepareDiagnosticExport(roots, c.req.param("traceId"));
    if (!prepared) return err(c, 404, "run not found");
    c.header("Cache-Control", "no-store");
    return c.json(prepared);
  });
}
