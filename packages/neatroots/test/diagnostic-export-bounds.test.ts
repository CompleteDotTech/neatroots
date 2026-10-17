import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { loadTrace } from "../src/engine/trace.js";
import { batch, hex, makeRoots, s, span, until } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

describe("bounded diagnostic export", () => {
  for (const ask of [
    `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(30)}\n-----END PRIVATE KEY-----`,
    `CLIENT-BEGIN:${"SyntheticCredentialMaterial".repeat(40)}:CLIENT-END`,
  ]) {
    it(`aliases actual generic planner IDs consistently (${ask.slice(0, 12)})`, async () => {
      const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => { cfg.cloud.redactPatterns = ["CLIENT-BEGIN:[\\s\\S]*?:CLIENT-END"]; } });
      cleanup.push(tb.close);
      const traceId = hex(16);
      tb.roots.ingest([batch([span({ traceId, name: "opaque checks", kind: "workflow", attrs: [s("neatlogs.workflow.input", ask)] })])]);
      vi.spyOn(tb.roots.llm, "isAvailable").mockResolvedValue(true);
      vi.spyOn(tb.roots.llm, "chat").mockResolvedValue({ json: { checks: [], new_questions: [{ id: "q1", ask }] }, text: "local fixture", model: "mock", latencyMs: 0 });
      const engine = new Engine(tb.roots, tb.roots.llm, tb.roots.decisions, tb.roots.checks, tb.roots.steering);
      const run = { traceId, project: "test-agent", workflow: "test-agent", used: { plans: 0 } };
      await (engine as unknown as { plan(live: typeof run, snap: ReturnType<typeof loadTrace>, tools: string[]): Promise<void> }).plan(run, loadTrace(tb.roots.store, traceId), []);
      const check = tb.roots.checks.all().find(({ check }) => check.kind !== "rule" && check.ask === ask)!.check;
      const fragment = ask.startsWith("-----") ? "miievqibadan" : "syntheticcredent";
      expect(check.id).toContain(fragment); // actual engine slug/truncation, not a hand-authored partial ID
      const removed = `${check.id}-removed`;
      const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: [check.id, removed], params: { [check.id]: { instruction: "Keep private" }, [removed]: { instruction: "Saved only" } }, tools: [] });
      tb.roots.store.setRunPlan(traceId, plan.id);
      tb.roots.store.insertFinding({ trace_id: traceId, check_id: check.id, check_kind: "question", title: "Question", probability: 0.9, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
      tb.roots.store.insertDecision({ trace_id: traceId, check_id: check.id, span_id: null, probability: 0.1, answer: { choice: "no" }, backend: "mock", latency_ms: 1 });
      const snapshot = () => ({ checks: tb.roots.checks.all(), plan: tb.roots.store.getPlan(plan.id), findings: tb.roots.store.findingsForTrace(traceId), decisions: tb.roots.store.decisionsForTrace(traceId), spans: tb.roots.store.batchesForTraces([traceId]) });
      const before = structuredClone(snapshot());
      const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
      expect(response.status).toBe(200);
      const prepared = await response.json();
      expect(JSON.stringify(prepared).toLowerCase()).not.toContain(fragment);
      const alias = prepared.bundle.findings[0].check_id;
      expect(alias).toMatch(/^check-[a-f0-9]{16}-\d+$/);
      expect(prepared.bundle.checks.decisions[0].check_id).toBe(alias);
      expect(prepared.bundle.checks.historical.recorded_check_ids[0]).toBe(alias);
      expect(prepared.bundle.checks.historical.params[alias]).toEqual({ instruction: "Keep private" });
      const definitions = prepared.bundle.checks.current_definitions;
      expect(definitions.find((d: { check_id: string }) => d.check_id === alias).definition.id).toBe(alias);
      const absent = prepared.bundle.checks.historical.recorded_check_ids[1];
      expect(absent).not.toBe(alias);
      expect(prepared.bundle.checks.historical.params[absent]).toEqual({ instruction: "Saved only" });
      expect(definitions.find((d: { check_id: string }) => d.check_id === absent)).toMatchObject({ available: false, definition: null });
      expect(snapshot()).toEqual(before);
    });
  }

  for (const scenario of ["single blob", "repeated blob references", "aggregate inline spans", "metadata"] as const) {
    it(`refuses oversized ${scenario} before hydration`, async () => {
      const tb = await makeRoots({ serve: true, noEngine: true });
      cleanup.push(tb.close);
      // Finish the constructor's independent startup reindex before observing export reads.
      await until(() => tb.roots.store.getMeta("search_index"));
      const traceId = hex(16);
      const payload = "x".repeat(scenario === "single blob" ? 3 * 1024 * 1024 : 800 * 1024);
      const attrs = scenario === "single blob" ? [s("payload", payload)] : scenario === "repeated blob references" ? [s("a", payload), s("b", payload), s("c", payload)] : [];
      tb.roots.ingest([batch([span({ traceId, name: "large run", kind: "workflow", attrs })])]);
      if (scenario === "aggregate inline spans") tb.roots.ingest([batch(Array.from({ length: 300 }, () => span({ traceId, name: "inline payload", kind: "tool", attrs: [s("payload", "x".repeat(8192))] })))]);
      if (scenario === "metadata") for (let i = 0; i < 6; i++) tb.roots.store.insertFinding({ trace_id: traceId, check_id: `large-${i}`, check_kind: "rule", title: "Metadata", probability: 1, status: "raised", evidence_span_ids: [], detail: { data: "x".repeat(400_000) }, model: null, triage_score: null, explanation_id: null });
      if (scenario.includes("blob")) expect(tb.roots.store.blobs.size()).toBeGreaterThan(32 * 1024);
      const hydrate = vi.spyOn(tb.roots.store, "batchesForTraces");
      const readBlob = vi.spyOn(tb.roots.store.blobs, "get");
      const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: expect.stringMatching(/too large.*2 MiB.*4 MiB/i) });
      expect(hydrate).not.toHaveBeenCalled();
      expect(readBlob).not.toHaveBeenCalled();
    });
  }

  it("refuses JSON escape expansion before serializing the response", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true }); cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "escape expansion", kind: "workflow", attrs: [s("payload", "\u0000".repeat(900_000))] })])]);
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/too large/i) });
  });

  it("exports a small real offloaded payload losslessly", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true }); cleanup.push(tb.close);
    const traceId = hex(16); const value = "x".repeat(40_000);
    tb.roots.ingest([batch([span({ traceId, name: "small blob", kind: "workflow", attrs: [s("payload", value)] })])]);
    expect(tb.roots.store.blobs.size()).toBe(40_000);
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(value);
    expect(tb.roots.store.batchesForTraces([traceId])[0].spans[0].attributes).toContainEqual(s("payload", value));
  });
});
