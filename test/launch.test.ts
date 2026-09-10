import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellEscape } from "../pi-extension/subagents/kitty.ts";
import { getSubagentsDir } from "../pi-extension/subagents/paths.ts";
import { buildClaudeCommand } from "../pi-extension/subagents/cli/claude.ts";
import {
  buildCdPrefix,
  buildEnvPrefix,
  buildPiLaunchPlan,
  buildPiResumePlan,
  scriptPreambleFor,
  scriptPathFor,
  withDoneSentinel,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  applySandboxToParts,
  buildPiParts,
  writeTaskArtifact,
  writeResumeMessageFile,
  SCRUB_PREFIX,
} from "../pi-extension/subagents/launch.ts";
import { timestampTag, sessionTimestamp } from "../pi-extension/subagents/format.ts";
import { contextArtifactName, launchScriptName, resumeScriptName } from "../pi-extension/subagents/names.ts";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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

describe("Phase 2/3 — unified plan pipeline (single env order, T2/T3)", () => {
  // Fixed inputs shared by all snapshots in this block. Timestamps/ids are
  // pinned (not Date.now()/Math.random()) so snapshots are deterministic.
  const FIX = {
    id: "abc123",
    name: "W",
    agent: "worker",
    agentDir: "/cfg",
    spawnable: ["scout"],
    sessionFile: "/sessions/s.jsonl",
    activityFile: "/art/activity-abc123.json",
    surface: "7",
    cwd: "/work proj",
    task: "do the thing",
    skills: "s1",
    artifactTs: "2026-01-02T03-04-05",
    msgTs: "2026-01-02T03-04-05",
  };

  /** Extract `KEY` order from a `KEY='v' KEY='v' ` env prefix. */
  function keysOf(prefix: string): string[] {
    return prefix
      .trim()
      .split(/\s+/)
      .map((tok) => tok.split("=")[0]);
  }

  // Reviewed unification (T2/T3): the old snapshots pinned a three-way
  // disagreement — canonical AGENT-before-NAME vs inline-launch NAME-before-
  // AGENT vs inline-resume AGENT-before-NAME with no SURFACE and AUTO_EXIT
  // last. Both plans now share buildEnvPrefix: AGENT before NAME, SURFACE
  // last, AUTO_EXIT after NAME (first-class `autoExit`). SURFACE is
  // write-only today (M10: no reader), so including it in resume is benign.
  const UNIFIED_ORDER = [
    "PI_CODING_AGENT_DIR",
    "PI_SUBAGENT_ALLOWED",
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_ACTIVITY_FILE",
    "PI_SUBAGENT_SURFACE",
  ];

  it("one env order across launch, resume, and buildEnvPrefix (T2/T3)", () => {
    const envOpts = {
      agentDir: FIX.agentDir,
      spawnable: FIX.spawnable,
      agent: FIX.agent,
      name: FIX.name,
      sessionFile: FIX.sessionFile,
      childId: FIX.id,
      activityFile: FIX.activityFile,
      surface: FIX.surface,
      autoExit: true,
    };
    assert.deepEqual(keysOf(buildEnvPrefix(envOpts)), UNIFIED_ORDER);

    const launchLoadout = {
      agent: FIX.agent,
      toolAllowlist: "read,ask_question",
      model: "test-model",
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: FIX.spawnable,
      autoExit: true,
      cwd: FIX.cwd,
      agentDir: FIX.agentDir,
    } as const;
    const launchDir = mkdtempSync(join(tmpdir(), "phase23-env-"));
    const launchTaskArg = writeTaskArtifact(launchDir, FIX.name, "t", FIX.artifactTs);
    const launch = buildPiLaunchPlan({
      sessionFile: FIX.sessionFile,
      loadout: launchLoadout as any,
      artifactDir: launchDir,
      name: FIX.name,
      surface: FIX.surface,
      taskArg: launchTaskArg,
      effectiveSkills: FIX.skills,
      taskDelivery: "artifact",
      childId: FIX.id,
      activityFile: FIX.activityFile,
      autoExit: true,
      targetCwd: FIX.cwd,
    });
    assert.deepEqual(keysOf(launch.envPrefix), UNIFIED_ORDER);

    const resumeDir = mkdtempSync(join(tmpdir(), "phase23-env-r-"));
    const resume = buildPiResumePlan({
      sessionPath: FIX.sessionFile,
      loadout: { ...launchLoadout, autoExit: false } as any,
      artifactDir: resumeDir,
      name: FIX.name,
      surface: FIX.surface,
      id: "resume1",
      activityFile: "/art/activity-resume1.json",
      message: "follow up please",
      resumeCwd: FIX.cwd,
      stamp: 456,
      msgTimestamp: FIX.msgTs,
    });
    assert.deepEqual(keysOf(resume.envPrefix), UNIFIED_ORDER);
    // AUTO_EXIT sits after NAME (canonical position), not last.
    assert.equal(keysOf(resume.envPrefix)[4], "PI_SUBAGENT_AUTO_EXIT");
  });

  it("pi launch plan snapshot (scrub + cd + env + parts + sentinel)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase23-pi-"));
    const loadout = {
      agent: FIX.agent,
      toolAllowlist: "read,ask_question",
      model: "test-model",
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: FIX.spawnable,
      autoExit: true,
      cwd: FIX.cwd,
      agentDir: FIX.agentDir,
    } as const;

    // Task artifact with a pinned timestamp (helper accepts ts for tests).
    const fullTask = "role\n\nmode\n\ntask\n\nsummary";
    const taskArg = writeTaskArtifact(dir, FIX.name, fullTask, FIX.artifactTs);
    assert.ok(taskArg.startsWith("@"));

    const plan = buildPiLaunchPlan({
      sessionFile: FIX.sessionFile,
      loadout: loadout as any,
      artifactDir: dir,
      name: FIX.name,
      surface: FIX.surface,
      taskArg,
      effectiveSkills: FIX.skills,
      taskDelivery: "artifact",
      childId: FIX.id,
      activityFile: FIX.activityFile,
      autoExit: true,
      targetCwd: FIX.cwd,
    });
    const { command } = plan;

    // Structural pins: scrub first, cd quoted (space in cwd), sentinel last.
    assert.ok(command.startsWith("unset PI_SUBAGENT_KEEP_TAB; "));
    assert.ok(command.includes(`cd ${shellEscape(FIX.cwd)} && `));
    assert.ok(command.includes(`PI_SUBAGENT_NAME=${shellEscape(FIX.name)}`));
    assert.ok(command.includes("--session"));
    assert.ok(command.includes("--no-extensions"));
    assert.ok(command.includes("--tools"));
    assert.ok(command.includes("--model"));
    assert.ok(command.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));

    // Exact snapshot: same helpers, canonical (unified) env order — the
    // reviewed diff vs the old inline snapshot is exactly the NAME/AGENT
    // swap (AGENT now before NAME).
    const subagentDonePath = join(getSubagentsDir(), "subagent-done.ts");
    const expectedParts: string[] = ["pi"];
    expectedParts.push("--session", shellEscape(FIX.sessionFile));
    expectedParts.push("-e", shellEscape(subagentDonePath));
    expectedParts.push("--model", shellEscape("test-model"));
    expectedParts.push("--no-extensions");
    expectedParts.push("--tools", shellEscape("read,ask_question"));
    const expectedPromptArgs = ["", "/skill:s1", taskArg].map((a) => shellEscape(a));
    const expectedEnv = buildEnvPrefix({
      agentDir: FIX.agentDir,
      spawnable: FIX.spawnable,
      agent: FIX.agent,
      name: FIX.name,
      sessionFile: FIX.sessionFile,
      childId: FIX.id,
      activityFile: FIX.activityFile,
      surface: FIX.surface,
      autoExit: true,
    });
    const expected = withDoneSentinel(
      `${SCRUB_PREFIX}${buildCdPrefix(FIX.cwd)}${expectedEnv}${[...expectedParts, ...expectedPromptArgs].join(" ")}`,
    );
    assert.equal(command, expected);

    // Plan parts agree with the single-home builder (no identity ⇒ no
    // timestamped sysprompt file, so fully deterministic).
    const canonicalParts = buildPiParts({
      sessionFile: FIX.sessionFile,
      loadout: loadout as any,
      artifactDir: dir,
      name: FIX.name,
      promptArgs: buildPiPromptArgs({ effectiveSkills: FIX.skills, taskDelivery: "artifact", taskArg }),
    });
    assert.deepEqual(plan.parts, canonicalParts);
    assert.equal(plan.cdPrefix, buildCdPrefix(FIX.cwd));
    assert.equal(plan.scriptFile, scriptPathFor(dir, `w-${FIX.id}.sh`));
  });

  it("claude launch snapshot (command + sentinel + unified preamble)", () => {
    const { command: claudeBase, sentinelFile } = buildClaudeCommand({
      id: FIX.id,
      task: FIX.task,
      model: "m",
      systemPrompt: "sys",
      cwd: FIX.cwd,
    });
    assert.equal(sentinelFile, `/tmp/pi-claude-${FIX.id}-done`);
    assert.ok(claudeBase.includes(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`));
    assert.ok(claudeBase.includes("--dangerously-skip-permissions"));
    assert.ok(claudeBase.includes(shellEscape(FIX.task)));
    assert.ok(claudeBase.startsWith(`cd ${shellEscape(FIX.cwd)} && `));

    const command = withDoneSentinel(claudeBase);
    assert.ok(command.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));

    // T2 unification (reviewed): the Claude path now uses scriptPreambleFor
    // like the pi path instead of its hand-built 3-liner. Same sink guard
    // (C1), one format, one place.
    const pre = scriptPreambleFor("claude-launch", { name: FIX.name, surface: FIX.surface });
    assert.equal(pre.split("\n")[0], `# Subagent claude-launch script for ${FIX.name}`);
    for (const line of pre.split("\n")) {
      assert.ok(line.startsWith("#"), `preamble line must stay a comment: ${line}`);
    }
    const canonical = scriptPreambleFor("launch", {
      name: FIX.name,
      sessionFile: FIX.sessionFile,
      surface: FIX.surface,
    });
    assert.ok(canonical.includes("# Subagent launch script for W"));
  });

  it("resume plan snapshot (loadout replay, canonical order with SURFACE)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase23-resume-"));
    const sessionPath = FIX.sessionFile;
    const loadout = {
      agent: FIX.agent,
      toolAllowlist: "read,ask_question",
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: FIX.spawnable,
      autoExit: false,
      cwd: FIX.cwd,
      agentDir: FIX.agentDir,
    } as const;

    const plan = buildPiResumePlan({
      sessionPath,
      loadout: loadout as any,
      artifactDir: dir,
      name: FIX.name,
      surface: FIX.surface,
      id: "resume1",
      activityFile: "/art/activity-resume1.json",
      message: "follow up please",
      resumeCwd: FIX.cwd,
      stamp: 456,
      msgTimestamp: FIX.msgTs,
    });
    const { command } = plan;

    assert.ok(command.startsWith("unset PI_SUBAGENT_KEEP_TAB; "));
    // Unified order: SURFACE present (was absent), AUTO_EXIT canonical.
    assert.deepEqual(keysOf(plan.envPrefix), UNIFIED_ORDER);
    assert.ok(plan.resumeMsgFile, "expected a resume message file");
    assert.ok(plan.resumeMsgFile!.endsWith(join("subagent-resume", `w-${FIX.msgTs}.md`)));
    assert.ok(plan.parts.includes(shellEscape(`@${plan.resumeMsgFile}`)));
    assert.ok(command.includes(shellEscape(`@${plan.resumeMsgFile}`)));
    assert.ok(command.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));
    assert.equal(plan.scriptFile, scriptPathFor(dir, "w-resume-456.sh"));
    assert.equal(plan.cdPrefix, buildCdPrefix(FIX.cwd));

    // No-message resume sends no @file prompt.
    const quiet = buildPiResumePlan({
      sessionPath,
      loadout: loadout as any,
      artifactDir: dir,
      name: FIX.name,
      surface: FIX.surface,
      id: "resume2",
      activityFile: "/art/activity-resume2.json",
      resumeCwd: FIX.cwd,
      stamp: 457,
    });
    assert.equal(quiet.resumeMsgFile, undefined);
    assert.ok(!quiet.parts.some((p) => p.includes("subagent-resume")));

    // Preamble baseline for the C1 fix (Generated line is time-varying).
    const pre = scriptPreambleFor("resume", {
      name: FIX.name,
      sessionFile: sessionPath,
      surface: FIX.surface,
      resumeMsgFile: plan.resumeMsgFile,
    });
    const normalized = pre.replace(/^# Generated: .*$/m, "# Generated: <TS>");
    assert.ok(normalized.includes("# Subagent resume script for W"));
    assert.ok(normalized.includes(`# Session: ${sessionPath}`));
    for (const line of normalized.split("\n")) {
      assert.ok(line.startsWith("#"), `preamble line must stay a comment: ${line}`);
    }
  });

  it("preamble injection fixed (C1): interpolated newlines stay comments", () => {
    // C1 fix: scriptPreambleFor collapses interior newlines in every
    // interpolated field, so an evil `name` cannot escape the `# …` comment.
    for (const evil of ["a\ntouch /tmp/pwned\n#", "x\ry\n", "ok"]) {
      const pre = scriptPreambleFor("launch", { name: evil, surface: "7" });
      for (const line of pre.split("\n")) {
        assert.ok(line.startsWith("#"), `preamble line must stay a comment: ${line}`);
      }
      assert.ok(!pre.includes("touch /tmp/pwned\n") && !pre.includes("\ntouch"));
    }
    const resume = scriptPreambleFor("resume", {
      name: "a\nb",
      sessionFile: "/s\nbad",
      surface: "7\nbad",
      resumeMsgFile: "/m\nbad",
    });
    for (const line of resume.split("\n")) {
      assert.ok(line.startsWith("#"), `resume preamble line must stay a comment: ${line}`);
    }
  });

  it("S3/S4 timestamps + naming live in single homes", () => {
    // S3: artifact tags are 19 chars; session filenames are a distinct
    // 23-char + `Z` shape (not just a different length).
    assert.equal(timestampTag(new Date("2026-01-02T03:04:05.000Z")), "2026-01-02T03-04-05");
    assert.equal(timestampTag(new Date("2026-01-02T03:04:05.000Z"), 23), "2026-01-02T03-04-05-000");
    assert.equal(sessionTimestamp(new Date("2026-01-02T03:04:05.123Z")), "2026-01-02T03-04-05-123Z");
    // S4: resume/launch filenames route through names.ts (slugify never
    // returns "", so no call-site `|| "resume"` remains).
    assert.equal(contextArtifactName("W", "2026-01-02T03-04-05"), "w-2026-01-02T03-04-05.md");
    assert.equal(resumeScriptName("W", 456), "w-resume-456.sh");
    assert.equal(launchScriptName("W", "abc123"), "w-abc123.sh");
    // Helpers write through the same names (pinned timestamps stay exact).
    const dir = mkdtempSync(join(tmpdir(), "phase23-names-"));
    const taskArg = writeTaskArtifact(dir, "W", "body", "2026-01-02T03-04-05");
    assert.equal(taskArg, `@${join(dir, "context", "w-2026-01-02T03-04-05.md")}`);
    const msgFile = writeResumeMessageFile(dir, "W", "hi", "2026-01-02T03-04-05");
    assert.equal(msgFile, join(dir, "subagent-resume", "w-2026-01-02T03-04-05.md"));
  });
});
