import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCdPrefix,
  buildEnvPrefix,
  scriptPreambleFor,
  scriptPathFor,
  withDoneSentinel,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  applySandboxToParts,
} from "../pi-extension/subagents/launch.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("launch.ts builders (R2 single command shape)", () => {
  it("buildCdPrefix quotes", () => {
    assert.equal(buildCdPrefix(null), "");
    assert.equal(buildCdPrefix("/tmp/a b"), "cd '/tmp/a b' && ");
  });

  it("withDoneSentinel appends the terminal marker", () => {
    assert.equal(withDoneSentinel("echo hi"), "echo hi; echo '__SUBAGENT_DONE_'$?'__'");
  });

  it("buildEnvPrefix orders keys like the historical launch path", () => {
    const prefix = buildEnvPrefix({
      agentDir: "/cfg",
      spawnable: ["scout"],
      agent: "worker",
      name: "W",
      sessionFile: "/s.jsonl",
      childId: "id1",
      activityFile: "/a.json",
      surface: "7",
      autoExit: true,
    });
    assert.ok(prefix.includes("PI_CODING_AGENT_DIR='/cfg'"));
    assert.ok(prefix.includes("PI_SUBAGENT_ALLOWED='scout'"));
    assert.ok(prefix.includes("PI_SUBAGENT_AUTO_EXIT=1"));
    assert.ok(prefix.endsWith(" "));
  });

  it("omits allowlist/auto-exit when not granted", () => {
    const prefix = buildEnvPrefix({
      name: "W",
      sessionFile: "/s.jsonl",
      childId: "id1",
      activityFile: "/a.json",
      surface: "7",
      autoExit: false,
    });
    assert.ok(!prefix.includes("PI_SUBAGENT_ALLOWED"));
    assert.ok(!prefix.includes("PI_SUBAGENT_AUTO_EXIT"));
  });

  it("scriptPreambleFor has one format", () => {
    const pre = scriptPreambleFor("launch", { name: "W", sessionFile: "/s", surface: "7" });
    assert.ok(pre.includes("# Subagent launch script for W"));
    assert.ok(pre.includes("# Session: /s"));
    const resume = scriptPreambleFor("resume", { name: "W", sessionFile: "/s", surface: "7", resumeMsgFile: "/m" });
    assert.ok(resume.includes("# Resume message file: /m"));
  });

  it("scriptPathFor nests under subagent-scripts", () => {
    assert.equal(scriptPathFor("/art", "w-id.sh"), join("/art", "subagent-scripts", "w-id.sh"));
  });

  it("buildSubagentToolAllowlist defaults + grants", () => {
    const base = buildSubagentToolAllowlist(undefined, { grantSpawning: false });
    assert.ok(base!.includes("read") && base!.includes("ask_question"));
    assert.ok(!base!.includes("subagent"));
    const granted = buildSubagentToolAllowlist("read,bash", { grantSpawning: true });
    assert.ok(granted!.includes("subagent") && granted!.includes("read"));
  });

  it("buildPiPromptArgs inserts the artifact separator for skills", () => {
    assert.deepEqual(buildPiPromptArgs({ effectiveSkills: "s1", taskDelivery: "artifact", taskArg: "@/a" }), [
      "",
      "/skill:s1",
      "@/a",
    ]);
    assert.deepEqual(buildPiPromptArgs({ effectiveSkills: "s1", taskDelivery: "direct", taskArg: "hi" }), [
      "/skill:s1",
      "hi",
    ]);
  });

  it("applySandboxToParts writes model + tools flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-test-"));
    const parts: string[] = ["pi"];
    applySandboxToParts(
      parts,
      {
        agent: "worker",
        toolAllowlist: "read,ask_question",
        model: "claude",
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: null,
        agentDir: null,
      },
      { artifactDir: dir, name: "W" },
    );
    assert.ok(parts.includes("--model"));
    assert.ok(parts.includes("--no-extensions"));
    assert.ok(parts.includes("--tools"));
  });

  it("applySandboxToParts persists identity to a sysprompt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-id-"));
    const parts: string[] = ["pi"];
    applySandboxToParts(
      parts,
      {
        agent: null,
        toolAllowlist: null,
        model: null,
        thinking: null,
        systemPromptMode: "append",
        identity: "you are a test",
        spawnable: null,
        autoExit: false,
        cwd: null,
        agentDir: null,
      },
      { artifactDir: dir, name: "W" },
    );
    const flagIdx = parts.indexOf("--append-system-prompt");
    assert.ok(flagIdx >= 0);
    const spPath = parts[flagIdx + 1].replace(/^'|'$/g, "");
    assert.equal(readFileSync(spPath, "utf8"), "you are a test");
  });
});
