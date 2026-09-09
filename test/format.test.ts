import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsed,
  formatElapsedMMSS,
  formatElapsedDuration,
  formatDuration,
  formatTokens,
  contextWindowFor,
  formatContextUsage,
  formatUsageSegments,
} from "../pi-extension/subagents/format.ts";

describe("format.ts (R4 single home)", () => {
  it("formatElapsed handles sub-minute and multi-minute", () => {
    assert.equal(formatElapsed(45), "45s");
    assert.equal(formatElapsed(72), "1m 12s");
  });

  it("formatElapsedMMSS renders MM:SS since start", () => {
    const start = 1_000_000;
    assert.equal(formatElapsedMMSS(start, start + 65_000), "01:05");
  });

  it("formatElapsedDuration handles s/m/h", () => {
    assert.equal(formatElapsedDuration(5_000), "5s");
    assert.equal(formatElapsedDuration(180_000), "3m");
    assert.equal(formatElapsedDuration(7_500_000), "2h 5m");
  });

  it("formatDuration dispatches by style", () => {
    assert.equal(formatDuration(45, "short-secs"), "45s");
    assert.equal(formatDuration(5_000, "human-ms"), "5s");
  });

  it("formatTokens compacts", () => {
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(3200), "3.2k");
    assert.equal(formatTokens(45_000), "45k");
  });

  it("contextWindowFor uses the table, unknown → undefined", () => {
    assert.equal(contextWindowFor("claude-sonnet-4"), 200_000);
    assert.equal(contextWindowFor("gpt-4o-mini"), 128_000);
    assert.equal(contextWindowFor("gemini-2.0"), 1_000_000);
    assert.equal(contextWindowFor("llama-3"), undefined);
    assert.equal(contextWindowFor(null), undefined);
  });

  it("formatContextUsage gauges with window or falls back", () => {
    assert.equal(formatContextUsage(36_000, 200_000), "18.0%/200k");
    assert.equal(formatContextUsage(1500, undefined), "1.5k ctx");
  });

  it("formatUsageSegments builds usage parts", () => {
    const segs = formatUsageSegments({
      model: "claude",
      toolCount: 3,
      inputTokens: 1500,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 0,
      cost: 0.01234,
    });
    assert.deepEqual(segs, ["↑1.5k", "↓800", "$0.012"]);
  });
});
