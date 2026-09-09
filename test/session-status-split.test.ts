import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countSessionEntryLines,
  getNewEntries,
  readEntriesAfter,
  findLastAssistantMessage,
  seedSubagentSessionFile,
  writeSubagentLoadout,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  readNameRegistry,
} from "../pi-extension/subagents/session.ts";
import { getLeafId, appendBranchSummary, copySessionFile, mergeNewEntries } from "../pi-extension/subagents/session/legacy-branch.ts";
import { activityLabel, statusObservationFromActivity } from "../pi-extension/subagents/status-bridge.ts";
import { borderLine, borderTop, borderBottom, widgetIcon, formatWidgetRightLabel } from "../pi-extension/subagents/widget.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";

function sessionFileWith(entries: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sess-split-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("session/ split (R8 barrel + single-pass read)", () => {
  it("readEntriesAfter returns slice + total in one read", () => {
    const f = sessionFileWith([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } },
    ]);
    assert.equal(countSessionEntryLines(f), 3);
    const { entries, total } = readEntriesAfter(f, 2);
    assert.equal(total, 3);
    assert.equal(entries.length, 1);
    assert.equal(findLastAssistantMessage(getNewEntries(f, 0)), "yo");
  });

  it("loadout round-trips beside the session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "loadout-"));
    const sf = join(dir, "s.jsonl");
    writeFileSync(sf, JSON.stringify({ type: "session", id: "x" }) + "\n");
    writeSubagentLoadout(sf, {
      agent: "worker",
      toolAllowlist: "read",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: null,
      agentDir: null,
    });
    assert.equal(readSubagentLoadout(sf)?.agent, "worker");
  });

  it("registry persists name → session", () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    registerName(dir, "w", { sessionFile: "/s.jsonl", sessionId: "id1" });
    assert.equal(resolveNameInRegistry(dir, "w")?.sessionId, "id1");
    assert.deepEqual(Object.keys(readNameRegistry(dir)), ["w"]);
  });

  it("seed creates lineage-only vs fork", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const parent = join(dir, "p.jsonl");
    writeFileSync(
      parent,
      [
        JSON.stringify({ type: "session", id: "p" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [] } }),
      ].join("\n") + "\n",
    );
    const child = join(dir, "c.jsonl");
    seedSubagentSessionFile({ mode: "lineage-only", parentSessionFile: parent, childSessionFile: child, childCwd: dir });
    assert.equal(countSessionEntryLines(child), 1);
  });

  it("legacy-branch helpers still work (deprecated)", () => {
    const f = sessionFileWith([{ type: "session", id: "s" }]);
    assert.equal(getLeafId(f), "s");
    appendBranchSummary(f, "s", null, "sum");
    assert.equal(countSessionEntryLines(f), 2);
    const dir = mkdtempSync(join(tmpdir(), "copy-"));
    const copy = copySessionFile(f, dir);
    assert.equal(countSessionEntryLines(copy), 2);
    const target = sessionFileWith([{ type: "session", id: "t" }]);
    assert.equal(mergeNewEntries(f, target, 1).length, 1);
  });
});

describe("status-bridge + widget (R9 single label pipeline)", () => {
  it("activityLabel only labels active scope", () => {
    assert.equal(
      activityLabel({ phase: "active", activeScope: "tool", toolName: "bash" } as any),
      "bash",
    );
    assert.equal(activityLabel({ phase: "waiting" } as any), undefined);
  });

  it("statusObservationFromActivity maps fields", () => {
    const obs = statusObservationFromActivity({
      updatedAt: 5,
      sequence: 2,
      phase: "active",
      activeScope: "tool",
      toolName: "bash",
    } as any);
    assert.equal(obs.snapshot, "present");
    assert.equal(obs.activityLabel, "bash");
  });

  it("widget borders + icons + right labels", () => {
    assert.ok(borderTop("T", "1 running", 20).includes("T"));
    assert.ok(borderLine("l", "r", 10).length > 0);
    assert.ok(borderBottom(10).length > 0);
    assert.ok(widgetIcon("active").includes("⟳"));
    const st = createStatusState({ source: "pi", startTimeMs: Date.now() });
    void st;
    assert.equal(formatWidgetRightLabel({ kind: "starting" } as any), " starting… ");
  });
});
