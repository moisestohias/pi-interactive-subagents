import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentStore, keptKey } from "../pi-extension/subagents/store.ts";
import {
  resolveResultPresentation,
  keptTabSuffix,
  notifyResult,
  notifyQuestion,
  notifyStatus,
} from "../pi-extension/subagents/notifications.ts";

describe("store.ts (R6 single identity owner)", () => {
  it("keptKey namespaces by artifact dir", () => {
    assert.equal(keptKey("/a", "w"), "/a::w");
  });

  it("uniqueName considers running + reserved + registry", () => {
    const s = new SubagentStore();
    s.addRunning({ id: "1", name: "w", sessionFile: "/s", surface: "1" });
    s.reserve("w-2");
    assert.equal(s.uniqueName("w", new Set(["w-3"])), "w-4");
    assert.equal(s.uniqueName("fresh"), "fresh");
  });

  it("resolveRunningByName reports missing/ambiguous", () => {
    const s = new SubagentStore();
    assert.ok((s.resolveRunningByName("x") as any).error.includes("No running"));
    s.addRunning({ id: "1", name: "dup", sessionFile: "/a", surface: "1" });
    s.addRunning({ id: "2", name: "dup", sessionFile: "/b", surface: "2" });
    assert.ok((s.resolveRunningByName("dup") as any).error.includes("Ambiguous"));
  });

  it("findKept prunes dead tabs", () => {
    const s = new SubagentStore();
    s.trackKept("/art", { name: "w", surface: "7", sessionFile: "/s", sessionId: null });
    assert.ok(s.findKept("/art", "w", () => true));
    assert.equal(s.findKept("/art", "w", () => false), null);
    assert.equal(s.kept.size, 0);
  });
});

describe("notifications.ts (R5 single envelope)", () => {
  it("resolveResultPresentation covers ok/fail/error", () => {
    assert.ok(resolveResultPresentation({ exitCode: 0, elapsed: 5, summary: "did it" }, "w").includes("completed"));
    assert.ok(
      resolveResultPresentation({ exitCode: 1, elapsed: 5, summary: "bad" }, "w").includes("exit code 1"),
    );
    assert.ok(
      resolveResultPresentation({ exitCode: 1, elapsed: 5, summary: "", errorMessage: "boom" }, "w").includes(
        "boom",
      ),
    );
  });

  it("keptTabSuffix appends only when kept", () => {
    assert.equal(keptTabSuffix(false), "");
    assert.ok(keptTabSuffix(true).includes("left open"));
  });

  it("notify helpers emit one steer envelope", () => {
    const seen: any[] = [];
    const pi = { sendMessage: (m: any, o: any) => void seen.push([m, o]) } as any;
    notifyResult(pi, { name: "w", summary: "ok", exitCode: 0, elapsed: 3 });
    assert.equal(seen[0][0].customType, "subagent_result");
    assert.deepEqual(seen[0][1], { triggerTurn: true, deliverAs: "steer" });

    notifyQuestion(pi, { name: "w", elapsedSec: 4, question: "q?" });
    assert.equal(seen[1][0].customType, "subagent_question");

    notifyStatus(pi, { content: "c", visibleLines: ["l"], overflow: 0 });
    assert.equal(seen[2][0].customType, "subagent_status");
  });
});
