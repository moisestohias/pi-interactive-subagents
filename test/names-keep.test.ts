import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugifyName, launchScriptName, resumeScriptName, safePathSegment } from "../pi-extension/subagents/names.ts";
import { resolveKeepDecision, resolveKeepForAgent, resolveResumeKeepDecision } from "../pi-extension/subagents/keep.ts";

describe("names.ts (Q1 single slug)", () => {
  it("slugifies display names for files", () => {
    assert.equal(slugifyName("My Worker!!"), "my-worker");
    assert.equal(slugifyName(""), "subagent");
    assert.equal(slugifyName(null), "subagent");
    assert.equal(slugifyName("  a  b  "), "a-b");
  });

  it("builds script names", () => {
    assert.equal(launchScriptName("My Worker", "abc123"), "my-worker-abc123.sh");
    assert.ok(resumeScriptName("W", 123).endsWith("-resume-123.sh"));
  });

  it("builds session-dir segments", () => {
    assert.equal(safePathSegment("/foo/bar:baz"), "---foo-bar-baz--".replace("---", "--"));
  });
});

describe("keep.ts (Q2 single truth table)", () => {
  it("keep ⇔ (keepOpen && !autoExit)", () => {
    assert.deepEqual(resolveKeepDecision({ keepOpen: false, autoExit: false }), {
      keepSurface: false,
      effectiveAutoExit: true,
    });
    assert.deepEqual(resolveKeepDecision({ keepOpen: false, autoExit: true }), {
      keepSurface: false,
      effectiveAutoExit: true,
    });
    assert.deepEqual(resolveKeepDecision({ keepOpen: true, autoExit: true }), {
      keepSurface: false,
      effectiveAutoExit: true,
    });
    assert.deepEqual(resolveKeepDecision({ keepOpen: true, autoExit: false }), {
      keepSurface: true,
      effectiveAutoExit: false,
    });
  });

  it("resolves per-agent and resume variants", () => {
    assert.equal(resolveKeepForAgent(true, { autoExit: false }).keepSurface, true);
    assert.equal(resolveKeepForAgent(true, null).keepSurface, true);
    assert.equal(resolveKeepForAgent(false, { autoExit: false }).keepSurface, false);
    assert.deepEqual(resolveResumeKeepDecision(), { keepSurface: false, effectiveAutoExit: true });
  });
});
