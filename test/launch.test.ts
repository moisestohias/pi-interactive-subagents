import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellEscape } from "../pi-extension/subagents/kitty.ts";
import { getSubagentsDir } from "../pi-extension/subagents/paths.ts";
import { buildClaudeCommand } from "../pi-extension/subagents/cli/claude.ts";
import {
  buildCdPrefix,
  buildEnvPrefix,
  scriptPreambleFor,
  scriptPathFor,
  withDoneSentinel,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  applySandboxToParts,
  buildPiParts,
  writeTaskArtifact,
  SCRUB_PREFIX,
} from "../pi-extension/subagents/launch.ts";
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

describe("Phase 0 — exact command snapshots (byte-identical gate, no source changes)", () => {
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

  /**
   * Verbatim replica of the inline launch env assembly
   * (index.ts launchSubagent ~1217-1244): NAME before AGENT.
   * Pinned here so the unification PR shows the order fix as a reviewed diff.
   */
  function inlineLaunchEnv(o: {
    agentDir: string | null;
    spawnable: string[] | null;
    grantSpawning: boolean;
    agent: string | null;
    name: string;
    autoExit: boolean;
    sessionFile: string;
    childId: string;
    activityFile: string;
    surface: string;
  }): string {
    const envParts: string[] = [];
    if (o.agentDir) envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(o.agentDir)}`);
    if (o.grantSpawning && o.spawnable) {
      envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(o.spawnable.join(","))}`);
    }
    envParts.push(`PI_SUBAGENT_NAME=${shellEscape(o.name)}`);
    if (o.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(o.agent)}`);
    if (o.autoExit) envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
    envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(o.sessionFile)}`);
    envParts.push(`PI_SUBAGENT_ID=${shellEscape(o.childId)}`);
    envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(o.activityFile)}`);
    envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(o.surface)}`);
    return envParts.join(" ") + " ";
  }

  /**
   * Verbatim replica of the inline resume env assembly
   * (index.ts subagent_message resume ~2278-2300): AGENT before NAME,
   * no SURFACE, AUTO_EXIT last.
   */
  function inlineResumeEnv(o: {
    agentDir: string | null;
    spawnable: string[] | null;
    agent: string | null;
    name: string;
    autoExit: boolean;
    sessionPath: string;
    childId: string;
    activityFile: string;
  }): string {
    const resumeEnvParts: string[] = [];
    if (o.agentDir) resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(o.agentDir)}`);
    if (o.spawnable && o.spawnable.length > 0) {
      resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(o.spawnable.join(","))}`);
    }
    if (o.agent) resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(o.agent)}`);
    resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(o.name)}`);
    resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(o.sessionPath)}`);
    resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(o.childId)}`);
    resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(o.activityFile)}`);
    if (o.autoExit) resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
    return resumeEnvParts.join(" ") + " ";
  }

  /**
   * Verbatim replica of the inline Claude launch preamble
   * (index.ts claude path ~1136-1140) — hand-built, bypasses
   * scriptPreambleFor. Pinned verbatim (C1 fix must cover this site too).
   */
  function inlineClaudePreamble(name: string, surface: string): string {
    return [
      `# Claude Code subagent launch script for ${name}`,
      `# Generated: 2026-01-02T03:04:05.000Z`,
      `# Surface: ${surface}`,
    ].join("\n");
  }

  it("env-order pin documents the three-way disagreement (T2)", () => {
    const opts = {
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
    const canonicalOrder = keysOf(buildEnvPrefix(opts));
    const launchOrder = keysOf(
      inlineLaunchEnv({ ...opts, grantSpawning: true }),
    );
    const resumeOrder = keysOf(
      inlineResumeEnv({ ...opts, sessionPath: opts.sessionFile }),
    );

    // Canonical: AGENT before NAME (launch.ts:50-66).
    assert.deepEqual(canonicalOrder, [
      "PI_CODING_AGENT_DIR",
      "PI_SUBAGENT_ALLOWED",
      "PI_SUBAGENT_AGENT",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_AUTO_EXIT",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_ID",
      "PI_SUBAGENT_ACTIVITY_FILE",
      "PI_SUBAGENT_SURFACE",
    ]);
    // Inline launch: NAME before AGENT (index.ts ~1241-1244) — disagrees.
    assert.deepEqual(launchOrder, [
      "PI_CODING_AGENT_DIR",
      "PI_SUBAGENT_ALLOWED",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_AGENT",
      "PI_SUBAGENT_AUTO_EXIT",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_ID",
      "PI_SUBAGENT_ACTIVITY_FILE",
      "PI_SUBAGENT_SURFACE",
    ]);
    // Inline resume: AGENT before NAME like canonical, but NO SURFACE and
    // AUTO_EXIT last (index.ts ~2284-2300).
    assert.deepEqual(resumeOrder, [
      "PI_CODING_AGENT_DIR",
      "PI_SUBAGENT_ALLOWED",
      "PI_SUBAGENT_AGENT",
      "PI_SUBAGENT_NAME",
      "PI_SUBAGENT_SESSION",
      "PI_SUBAGENT_ID",
      "PI_SUBAGENT_ACTIVITY_FILE",
      "PI_SUBAGENT_AUTO_EXIT",
    ]);

    // The disagreement is the point: do not "fix" here. The Phase-5
    // unification PR updates this test to assert one shared order.
    assert.notDeepEqual(canonicalOrder, launchOrder);
    assert.ok(!resumeOrder.includes("PI_SUBAGENT_SURFACE"));
  });

  it("pi launch full command snapshot (scrub + cd + env + parts + sentinel)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase0-pi-"));
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

    // Inline parts assembly, verbatim replica of index.ts ~1196-1269
    // (pi --session + -e subagent-done + sandbox + prompt args).
    const subagentDonePath = join(getSubagentsDir(), "subagent-done.ts");
    const parts: string[] = ["pi"];
    parts.push("--session", shellEscape(FIX.sessionFile));
    parts.push("-e", shellEscape(subagentDonePath));
    applySandboxToParts(parts as any, loadout as any, { artifactDir: dir, name: FIX.name });
    for (const promptArg of buildPiPromptArgs({
      effectiveSkills: FIX.skills,
      taskDelivery: "artifact",
      taskArg,
    })) {
      parts.push(shellEscape(promptArg));
    }

    const envPrefix = inlineLaunchEnv({
      agentDir: FIX.agentDir,
      spawnable: FIX.spawnable,
      grantSpawning: true,
      agent: FIX.agent,
      name: FIX.name,
      autoExit: true,
      sessionFile: FIX.sessionFile,
      childId: FIX.id,
      activityFile: FIX.activityFile,
      surface: FIX.surface,
    });
    const cdPrefix = buildCdPrefix(FIX.cwd);
    const command = withDoneSentinel(`${SCRUB_PREFIX}${cdPrefix}${envPrefix}${parts.join(" ")}`);

    // Structural pins: scrub first, cd quoted (space in cwd), sentinel last.
    assert.ok(command.startsWith("unset PI_SUBAGENT_KEEP_TAB; "));
    assert.ok(command.includes(`cd ${shellEscape(FIX.cwd)} && `));
    assert.ok(command.includes(`PI_SUBAGENT_NAME=${shellEscape(FIX.name)}`));
    assert.ok(command.includes("--session"));
    assert.ok(command.includes("--no-extensions"));
    assert.ok(command.includes("--tools"));
    assert.ok(command.includes("--model"));
    assert.ok(command.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));

    // Exact snapshot: rebuild the expectation literally (same helpers, inline
    // order) so any order/quoting drift fails byte-identical comparison.
    const expectedParts: string[] = ["pi"];
    expectedParts.push("--session", shellEscape(FIX.sessionFile));
    expectedParts.push("-e", shellEscape(subagentDonePath));
    expectedParts.push("--model", shellEscape("test-model"));
    expectedParts.push("--no-extensions");
    expectedParts.push("--tools", shellEscape("read,ask_question"));
    const expectedPromptArgs = ["", "/skill:s1", taskArg].map((a) => shellEscape(a));
    const expected =
      withDoneSentinel(
        `${SCRUB_PREFIX}${buildCdPrefix(FIX.cwd)}${envPrefix}${[...expectedParts, ...expectedPromptArgs].join(" ")}`,
      );
    assert.equal(command, expected);

    // Canonical buildPiParts agrees on this shape (no identity ⇒ no
    // timestamped sysprompt file, so fully deterministic).
    const canonicalParts = buildPiParts({
      sessionFile: FIX.sessionFile,
      loadout: loadout as any,
      artifactDir: dir,
      name: FIX.name,
      promptArgs: buildPiPromptArgs({ effectiveSkills: FIX.skills, taskDelivery: "artifact", taskArg }),
    });
    assert.deepEqual(parts, canonicalParts);
  });

  it("claude launch snapshot (command + sentinel + inline preamble verbatim)", () => {
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

    // Inline Claude preamble pinned verbatim (differs from
    // scriptPreambleFor("launch", …) — backends disagree today).
    const inline = inlineClaudePreamble(FIX.name, FIX.surface);
    assert.ok(inline.includes(`# Claude Code subagent launch script for ${FIX.name}`));
    for (const line of inline.split("\n")) {
      assert.ok(line.startsWith("#"), `preamble line must stay a comment: ${line}`);
    }
    const canonical = scriptPreambleFor("launch", {
      name: FIX.name,
      sessionFile: FIX.sessionFile,
      surface: FIX.surface,
    });
    assert.ok(canonical.includes("# Subagent launch script for W"));
    assert.notEqual(inline.split("\n")[0], canonical.split("\n")[0]);
  });

  it("resume command snapshot (loadout replay, AUTO_EXIT last, no SURFACE)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase0-resume-"));
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

    // Inline resume parts, verbatim replica of index.ts ~2245-2260.
    const subagentDonePath = join(getSubagentsDir(), "subagent-done.ts");
    const parts = ["pi", "--session", shellEscape(sessionPath)];
    parts.push("-e", shellEscape(subagentDonePath));
    applySandboxToParts(parts as any, loadout as any, { artifactDir: dir, name: FIX.name });

    // Deterministic resume message file (inline pattern, pinned timestamp).
    const resumeMsgFile = join(dir, "subagent-resume", `w-${FIX.msgTs}.md`);
    mkdirSync(join(dir, "subagent-resume"), { recursive: true });
    writeFileSync(resumeMsgFile, "follow up please", "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));

    const resumeEnvPrefix = inlineResumeEnv({
      agentDir: FIX.agentDir,
      spawnable: FIX.spawnable,
      agent: FIX.agent,
      name: FIX.name,
      autoExit: true, // resume is always autonomous
      sessionPath,
      childId: "resume1",
      activityFile: "/art/activity-resume1.json",
    });
    const resumeCdPrefix = buildCdPrefix(loadout.cwd);
    const command = withDoneSentinel(
      `unset PI_SUBAGENT_KEEP_TAB; ${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}`,
    );

    assert.ok(command.startsWith("unset PI_SUBAGENT_KEEP_TAB; "));
    assert.ok(!keysOf(resumeEnvPrefix).includes("PI_SUBAGENT_SURFACE"));
    assert.equal(keysOf(resumeEnvPrefix).at(-1), "PI_SUBAGENT_AUTO_EXIT");
    assert.ok(command.includes(shellEscape(`@${resumeMsgFile}`)));
    assert.ok(command.endsWith("; echo '__SUBAGENT_DONE_'$?'__'"));

    // Preamble baseline for the C1 fix (Generated line is time-varying).
    const pre = scriptPreambleFor("resume", {
      name: FIX.name,
      sessionFile: sessionPath,
      surface: FIX.surface,
      resumeMsgFile,
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
    // (Phase 0 pinned the vulnerable behavior; this asserts the fix.)
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
});
