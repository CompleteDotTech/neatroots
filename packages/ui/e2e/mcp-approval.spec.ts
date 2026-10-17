import { expect, test } from "@playwright/test";
import { open, state } from "./util";

async function propose(check: string) {
  const url = `${state().url}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "approval-e2e", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const h = { ...headers, ...(session ? { "mcp-session-id": session } : {}) };
  try {
    await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const result = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_check", arguments: { check } } }) });
    expect(result.ok).toBe(true);
    await result.text();
  } finally {
    if (session) await fetch(url, { method: "DELETE", headers: h });
  }
}

test("a real MCP proposal activates only after approval in the app", async ({ page }, testInfo) => {
  const id = `approval-e2e-${testInfo.repeatEachIndex}-${Date.now()}`;
  const list = async () => (await page.request.get(`${state().url}/api/checks`)).json();
  try {
    await propose(`id: ${id}\nkind: rule\naction: halt\nrule: { type: count, at_least: 2 }\n`);
    const pending = await list();
    expect(pending.checks.some((c: { id: string }) => c.id === id)).toBe(false);
    expect(pending.pending_mcp_checks.some((c: { id: string }) => c.id === id)).toBe(true);
    await open(page, "checks");
    const proposal = page.getByTestId("mcp-check-proposal").filter({ hasText: id });
    await expect(proposal).toBeVisible();
    await proposal.getByRole("button", { name: "Approve check" }).click();
    await expect(proposal).toHaveCount(0);
    await expect.poll(async () => (await list()).checks.find((c: { id: string }) => c.id === id)?.source).toBe("mcp");
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: id })).toBeVisible();
  } finally {
    const pending = (await list()).pending_mcp_checks?.find((c: { id: string }) => c.id === id);
    if (pending) await page.request.post(`${state().url}/api/checks/${id}/reject`, { data: { revision: pending.revision } });
    await page.request.delete(`${state().url}/api/checks/${id}`);
  }
});
