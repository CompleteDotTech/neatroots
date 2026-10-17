import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { makeRoots, type TestRoots } from "./helpers.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let t: TestRoots | undefined;
const savedBin = process.env.NEATROOTS_CODEX_BIN;
afterEach(async () => {
  vi.mocked(spawn).mockReset();
  if (savedBin === undefined) delete process.env.NEATROOTS_CODEX_BIN;
  else process.env.NEATROOTS_CODEX_BIN = savedBin;
  await t?.close();
  t = undefined;
});

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
}

async function session() {
  process.env.NEATROOTS_CODEX_BIN = process.execPath;
  t = await makeRoots({ noEngine: true });
  return t.roots.chats.create({ agent: "codex", cwd: process.cwd() });
}

it("preserves UTF-8 text split across stdout chunks and ignores malformed event lines", async () => {
  const s = await session();
  const p = child();
  vi.mocked(spawn).mockReturnValueOnce(p as unknown as ChildProcess);
  const done = t!.roots.chats.send(s.id, "hello");
  const answer = "Café — 中文 🐈";
  const bytes = Buffer.from("not-json\n" + JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }) + "\n");
  // A byte at a time deterministically splits every multi-byte code point.
  for (const byte of bytes) p.stdout.write(Buffer.from([byte]));
  p.stdout.end();
  p.emit("close", 0, null);
  await done;
  expect(t!.roots.chats.events(s.id).filter((e) => e.kind === "text").map((e) => e.text)).toEqual([answer]);
  expect(t!.roots.chats.get(s.id)?.state).toBe("idle");
});

it("preserves UTF-8 diagnostic text split across stderr chunks", async () => {
  const s = await session();
  const p = child();
  vi.mocked(spawn).mockReturnValueOnce(p as unknown as ChildProcess);
  const done = t!.roots.chats.send(s.id, "hello");
  const diagnostic = "Provider failed: Café — 中文 🐈";
  for (const byte of Buffer.from(diagnostic)) p.stderr.write(Buffer.from([byte]));
  p.stderr.end();
  p.emit("close", 1, null);
  await done;
  const errors = t!.roots.chats.events(s.id).filter((e) => e.kind === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0].text).toContain(diagnostic);
  expect(t!.roots.chats.get(s.id)?.state).toBe("error");
});

it("records synchronous spawn failure and allows another turn", async () => {
  const s = await session();
  vi.mocked(spawn).mockImplementationOnce(() => { throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }); });
  await t!.roots.chats.send(s.id, "first");
  expect(t!.roots.chats.get(s.id)?.state).toBe("error");
  expect(t!.roots.chats.events(s.id).filter((e) => e.kind === "error").map((e) => e.text)).toEqual(["spawn E2BIG"]);
  expect(t!.roots.chats.stop(s.id)).toBe(false);
  const p = child();
  vi.mocked(spawn).mockReturnValueOnce(p as unknown as ChildProcess);
  const done = t!.roots.chats.send(s.id, "retry");
  p.emit("close", 0, null);
  await done;
  expect(t!.roots.chats.get(s.id)?.state).toBe("idle");
  expect(t!.roots.chats.stop(s.id)).toBe(false);
});
