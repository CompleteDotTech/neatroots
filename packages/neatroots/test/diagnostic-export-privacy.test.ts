import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateRule } from "../src/checks/rules.js";
import { checkTitle, type QuestionCheck, type RuleCheck } from "../src/checks/types.js";
import { draftCheckFromConcern } from "../src/engine/assist.js";
import { Engine } from "../src/engine/engine.js";
import { loadTrace } from "../src/engine/trace.js";
import { batch, hex, makeRoots, s, span, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

const keyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(40).match(/.{1,64}/g)!.join("\n");
const secrets = [
  { name: "multiline PEM", value: `-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n-----END RSA PRIVATE KEY-----`, fragment: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", marker: "private_key" },
  { name: "delimited custom credential", value: `CLIENT-BEGIN:${"SyntheticCredentialMaterial".repeat(40)}:CLIENT-END`, fragment: "SyntheticCredentialMaterial", marker: "custom" },
  // The prefix lands near the clipping boundary: the fragment is too short for the API-key matcher.
  { name: "credential at clipping boundary", value: `${" ".repeat(184)}sk-SyntheticApiCredentialMaterial0123456789`, fragment: "sk-Synthetic", marker: "api_key" },
];

describe("diagnostic export privacy", () => {
  for (const secret of secrets.slice(0, 2)) {
    for (const producer of ["planner", "draft"] as const) {
      it(`omits source-clipped ${producer} question titles for ${secret.name}`, async () => {
        const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => {
          cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"];
        } });
        cleanup.push(tb.close);
        const traceId = hex(16);
        const ask = `Did the agent reveal ${secret.value}?`;
        const fragment = secret.fragment.slice(0, 16);
        tb.roots.ingest([batch([span({ traceId, name: "title regression", kind: "workflow", attrs: [s("neatlogs.workflow.input", ask)] })])]);
        const question = { id: "diagnostic-sensitive-question", ask, scope: "trace", span_type: "tool" };
        vi.spyOn(tb.roots.llm, "isAvailable").mockResolvedValue(true);
        vi.spyOn(tb.roots.llm, "chat").mockResolvedValue({
          json: producer === "planner" ? { checks: [], new_questions: [question] } : question,
          text: "synthetic local fixture", model: "mock", latencyMs: 0,
        });
        let check: QuestionCheck;
        if (producer === "draft") {
          check = await draftCheckFromConcern(tb.roots, "Check credential disclosure");
          tb.roots.checks.save(check, "user", "user");
        } else {
          // Invoke the actual planner method without starting an asynchronous run controller.
          // Only the model result is mocked; engine.ts creates and persists the clipped title.
          const engine = new Engine(tb.roots, tb.roots.llm, tb.roots.decisions, tb.roots.checks, tb.roots.steering);
          const run = { traceId, project: "test-agent", workflow: "test-agent", used: { plans: 0 } };
          await (engine as unknown as { plan(live: typeof run, snap: ReturnType<typeof loadTrace>, tools: string[]): Promise<void> })
            .plan(run, loadTrace(tb.roots.store, traceId), []);
          check = tb.roots.checks.all().find(({ check }) => check.kind !== "rule" && check.ask === ask)!.check as QuestionCheck;
        }
        // These prefixes come from the actual producer above, not a partial-secret fixture.
        expect(check.ask).toBe(ask);
        expect(check.title).toBe(producer === "planner" ? `${ask.slice(0, 79)}…` : ask.slice(0, 80));
        expect(check.title).toContain(fragment);
        expect(check.title).not.toContain(secret.marker === "private_key" ? "-----END RSA PRIVATE KEY-----" : ":CLIENT-END");
        const finding = tb.roots.store.insertFinding({
          trace_id: traceId, check_id: check.id, check_kind: "question", title: checkTitle(check), probability: 0.9,
          status: "raised", evidence_span_ids: [], detail: { backend: "mock" }, model: null, triage_score: null, explanation_id: null,
        });
        const before = { check: structuredClone(tb.roots.checks.get(check.id)), spans: tb.roots.store.batchesForTraces([traceId]) };
        const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
        expect(response.status).toBe(200);
        const prepared = await response.json();
        const current = prepared.bundle.checks.current_definitions.find((c: { check_id: string }) => c.check_id === prepared.bundle.findings[0].check_id);
        expect(current.definition.ask).toBe(`Did the agent reveal [redacted:${secret.marker}]?`);
        expect(JSON.stringify(prepared.bundle.trace)).toContain(`[redacted:${secret.marker}]`);
        expect(JSON.stringify(prepared)).not.toContain(fragment);
        expect(current.definition).not.toHaveProperty("title");
        expect(prepared.bundle.findings[0]).toMatchObject({ check_id: current.check_id, status: "raised", detail: { backend: "mock" } });
        expect(prepared.bundle.findings[0]).not.toHaveProperty("title");
        expect(tb.roots.checks.get(check.id)).toEqual(before.check);
        expect(tb.roots.store.getFinding(finding.id)).toEqual(finding);
        expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before.spans);

        tb.roots.checks.save({ ...check, ask: "Did the current question change?", title: "Current title" }, "user", "user");
        const changed = await (await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`)).json();
        expect(changed.bundle.checks.current_definitions.find((c: { check_id: string }) => c.check_id === changed.bundle.findings[0].check_id).definition.ask).toBe("Did the current question change?");
        expect(changed.bundle.findings[0]).not.toHaveProperty("ask");
        expect(JSON.stringify(changed)).not.toContain(fragment);
        expect(tb.roots.store.getFinding(finding.id)).toEqual(finding);
      });
    }
  }

  it("omits a failed-check error containing an actual client-clipped HTTP body", async () => {
    const secret = secrets[0];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => req.url === "/models"
        ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "mock-model" }] }))
        : res.writeHead(500).end(secret.value));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const tb = await makeRoots({ serve: true, noEngine: true, llmUrl: `http://127.0.0.1:${port}` });
    cleanup.push(async () => { await tb.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "failed question", kind: "workflow", attrs: [s("neatlogs.workflow.input", secret.value)] })])]);
    const error = await tb.roots.llm.chat([{ role: "user", content: "Synthetic local request" }]).then(() => { throw new Error("expected mock HTTP failure"); }, (err: Error) => err);
    expect(error.message).toBe(`LLM HTTP 500: ${secret.value.slice(0, 300)}`);
    expect(error.message).toContain(secret.fragment);
    expect(error.message).not.toContain("-----END RSA PRIVATE KEY-----");
    const finding = tb.roots.store.insertFinding({
      trace_id: traceId, check_id: "diagnostic.failed-question", check_kind: "question", title: "Question failed", probability: null,
      status: "failed", evidence_span_ids: [], detail: { error: error.message, span_id: null }, model: null, triage_score: null, explanation_id: null,
    });
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    expect(JSON.stringify(prepared)).not.toContain(secret.fragment);
    expect(prepared.bundle.findings[0]).toMatchObject({ check_id: expect.stringMatching(/^check-[a-f0-9]{16}-\d+$/), status: "failed", detail: { span_id: null } });
    expect(prepared.bundle.findings[0].detail).not.toHaveProperty("error");
    expect(tb.roots.store.getFinding(finding.id)).toEqual(finding);
  });

  for (const secret of secrets) {
    for (const type of ["repeat", "errors"] as const) {
      it(`omits already-clipped ${type} finding params for ${secret.name}`, async () => {
        const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => {
          cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"];
        } });
        cleanup.push(tb.close);
        const traceId = hex(16);
        const root = hex(8);
        // Repeat results clip at 120, error streaks at 200. Leave only a short
        // credential prefix at the respective boundary, below matcher length.
        const value = secret.marker === "api_key"
          ? secret.value.replace(/^\s+/, " ".repeat(type === "repeat" ? 104 : 184))
          : secret.value;
        tb.roots.ingest([batch([
          span({ traceId, spanId: root, name: "privacy regression", kind: "workflow", attrs: [s("neatlogs.workflow.output", "Done")] }),
          ...Array.from({ length: 3 }, () => toolSpan(traceId, root, "lookup", value, value, value)),
        ])]);
        const check: RuleCheck = {
          id: `diagnostic.${type}`, kind: "rule",
          rule: type === "repeat"
            ? { type: "repeat", span: { type: "tool" }, same: ["tool", "input"], at_least: 3 }
            : { type: "errors", span: { type: "tool" }, consecutive: 3 },
        };
        const hit = evaluateRule(check, loadTrace(tb.roots.store, traceId), false)!;
        expect(hit.firing).toBe(true);
        expect(hit.params[type === "repeat" ? "result" : "error"]).toContain(secret.fragment);
        expect(hit.params[type === "repeat" ? "result" : "error"]!.length).toBeLessThanOrEqual(200);
        tb.roots.store.insertFinding({
          trace_id: traceId, check_id: check.id, check_kind: "rule", title: "Repeated tool failure",
          probability: 1, status: "raised", evidence_span_ids: hit.evidenceSpanIds,
          detail: { params: hit.params, source: "db", group: "reliability" },
          model: null, triage_score: null, explanation_id: null,
        });
        const before = {
          batches: tb.roots.store.batchesForTraces([traceId]),
          findings: tb.roots.store.findingsForTrace(traceId),
        };
        const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
        expect(response.status).toBe(200);
        const prepared = await response.json();
        // Preview and download both use this bundle; scan the entire response for fragments.
        expect(JSON.stringify(prepared)).not.toContain(secret.fragment);
        expect(JSON.stringify(prepared.bundle.trace)).toContain(`[redacted:${secret.marker}]`);
        expect(prepared.bundle.findings[0].detail).toEqual({ source: "db", group: "reliability" });
        expect(prepared.bundle.checks.historical.params).toEqual({});
        expect(tb.roots.store.batchesForTraces([traceId])).toEqual(before.batches);
        expect(tb.roots.store.findingsForTrace(traceId)).toEqual(before.findings);
      });
    }
  }

  it("also omits clipped error parameters and verification quotes added to question findings", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => {
      cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"];
    } });
    cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "question finding", kind: "workflow" })])]);
    tb.roots.store.insertFinding({
      trace_id: traceId, check_id: "diagnostic.question", check_kind: "question", title: "Tool failed",
      probability: 0.99, status: "raised", evidence_span_ids: [],
      detail: { params: { error: `${secrets[0].value.slice(0, 159)}…` }, quote: secrets[1].value.slice(0, 300), backend: "mock", choice: "yes" },
      model: null, triage_score: null, explanation_id: null,
    });
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    expect(JSON.stringify(prepared)).not.toContain(secrets[0].fragment);
    expect(JSON.stringify(prepared)).not.toContain(secrets[1].fragment);
    expect(prepared.bundle.findings[0].detail).toEqual({ backend: "mock", choice: "yes" });
  });

  it("exports redacted saved parameters for a clean decision independently of current definitions", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => {
      cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"];
    } });
    cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "clean decision", kind: "workflow" })])]);
    const id = "diagnostic.instruction";
    tb.roots.checks.save({ id, kind: "yes_no", ask: "Did the agent violate {instruction}?", params: { instruction: "Current, changed instruction" } }, "db", "planner");
    const params = {
      [id]: { instruction: "Always confirm the order number", pem: secrets[0].value, custom: secrets[1].value, api: secrets[2].value },
      "removed.question": { instruction: "Keep this historical substitution" },
    };
    const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: [id, "removed.question"], params, tools: [] });
    tb.roots.store.setRunPlan(traceId, plan.id);
    const decision = tb.roots.store.insertDecision({ trace_id: traceId, check_id: id, span_id: null, probability: 0.01, answer: { choice: "no" }, backend: "mock", latency_ms: 1 });
    const storedPlan = tb.roots.store.getPlan(plan.id);
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const prepared = await response.json();
    expect(prepared.bundle.findings).toEqual([]);
    const alias = prepared.bundle.checks.decisions[0].check_id;
    const removedAlias = prepared.bundle.checks.historical.recorded_check_ids[1];
    expect(alias).toMatch(/^check-[a-f0-9]{16}-\d+$/);
    expect(prepared.bundle.checks.decisions).toEqual([expect.objectContaining({ check_id: alias, answer: decision.answer })]);
    expect(prepared.bundle.checks.historical).toMatchObject({
      plan_available: true, recorded_check_ids: [alias, removedAlias], historical_definitions: "not-retained",
      params: {
        [alias]: { instruction: params[id].instruction, pem: "[redacted:private_key]", custom: "[redacted:custom]", api: `${" ".repeat(184)}[redacted:api_key]` },
        [removedAlias]: params["removed.question"],
      },
    });
    expect(prepared.bundle.checks.current_definitions).toContainEqual(expect.objectContaining({ check_id: alias, definition: expect.objectContaining({ params: { instruction: "Current, changed instruction" } }) }));
    for (const secret of secrets) expect(JSON.stringify(prepared)).not.toContain(secret.fragment);
    expect(tb.roots.store.getPlan(plan.id)).toEqual(storedPlan);
    expect(tb.roots.store.decisionsForTrace(traceId)).toEqual([decision]);
  });
});
