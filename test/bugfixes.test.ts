import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// M5: lineLimit is now configurable and validated.
import { parseStatusConfig } from "../pi-extension/subagents/status.ts";
// M3/C4: torn lines are skipped, never thrown.
import {
  readEntries,
  getNewEntries,
  readEntriesAfter,
} from "../pi-extension/subagents/session/io.ts";
// N14: clamped formatters.
import { formatElapsed, formatElapsedMMSS } from "../pi-extension/subagents/format.ts";
// M6/M7: claude builder is the wired canonical (no void-preamble, plugin-dir kept).
import { buildClaudeCommand } from "../pi-extension/subagents/cli/claude.ts";
// M9: safe_bash blocks (incl. new substitution/flag cases).
import { isDangerous } from "../pi-extension/subagents/tools/safe-bash.ts";
// M2/C3: store-backed names + atomic ask-claim path via index test hooks.
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const testApi = (subagentsModule as any).__test__;

function sessionFileWithRaw(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bugfix-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, raw);
  return file;
}

describe("M5 status.lineLimit", () => {
  it("accepts a positive int lineLimit", () => {
    const cfg = parseStatusConfig({ status: { enabled: true, lineLimit: 7 } }, "test");
    assert.equal(cfg.lineLimit, 7);
  });

  it("defaults lineLimit when absent", () => {
    const cfg = parseStatusConfig({ status: { enabled: false } }, "test");
    assert.equal(cfg.lineLimit, 4);
  });

  it("rejects non-positive / non-integer lineLimit", () => {
    assert.throws(() => parseStatusConfig({ status: { enabled: true, lineLimit: 0 } }, "test"));
    assert.throws(() => parseStatusConfig({ status: { enabled: true, lineLimit: -2 } }, "test"));
    assert.throws(() => parseStatusConfig({ status: { enabled: true, lineLimit: 1.5 } }, "test"));
    assert.throws(() => parseStatusConfig({ status: { enabled: true, lineLimit: "many" } }, "test"));
  });

  it("still rejects unknown status keys", () => {
    assert.throws(() => parseStatusConfig({ status: { enabled: true, bogus: 1 } }, "test"));
  });
});

describe("M3/C4 tolerant JSONL readers", () => {
  const raw =
    JSON.stringify({ type: "session", id: "s" }) +
    "\n" +
    "{torn json line\n" +
    JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) +
    "\n   \n" +
    "not json at all\n";

  it("readEntries skips torn lines", () => {
    const entries = readEntries(sessionFileWithRaw(raw));
    assert.equal(entries.length, 2);
    assert.equal(entries[1].id, "m1");
  });

  it("getNewEntries skips torn lines", () => {
    const entries = getNewEntries(sessionFileWithRaw(raw), 0);
    assert.equal(entries.length, 2);
  });

  it("readEntriesAfter reports skipped count", () => {
    const { entries, total, skipped } = readEntriesAfter(sessionFileWithRaw(raw), 1);
    assert.equal(total, 4);
    assert.equal(entries.length, 1);
    assert.equal(skipped, 2);
  });
});

describe("N14 clamped formatters", () => {
  it("never prints negative durations", () => {
    assert.equal(formatElapsed(-3), "0s");
    assert.equal(formatElapsed(NaN), "0s");
    assert.equal(formatElapsedMMSS(1000, 500), "00:00");
  });
});

describe("M6/M7 claude builder canonical", () => {
  it("builds sentinel + plugin-dir + model + task", () => {
    const { command, sentinelFile } = buildClaudeCommand({
      id: "abc123",
      task: "do it",
      model: "claude-x",
      systemPrompt: "be nice",
      cwd: "/tmp/wd",
    });
    assert.equal(sentinelFile, "/tmp/pi-claude-abc123-done");
    assert.ok(command.startsWith("cd '/tmp/wd' && "));
    assert.ok(command.includes("PI_CLAUDE_SENTINEL='/tmp/pi-claude-abc123-done'"));
    assert.ok(command.includes("--model 'claude-x'"));
    assert.ok(command.includes("--append-system-prompt 'be nice'"));
    assert.ok(command.includes("'do it'"));
  });

  it("omits optional flags when absent", () => {
    const { command } = buildClaudeCommand({ id: "z", task: "t", model: null, systemPrompt: null, cwd: null });
    assert.ok(!command.includes("--model"));
    assert.ok(!command.includes("--append-system-prompt"));
    assert.ok(!command.startsWith("cd "));
  });
});

describe("M9 safe_bash blocks", () => {
  it("blocks classic dangerous commands", () => {
    assert.ok(isDangerous("rm -rf /"));
    assert.ok(isDangerous("sudo apt update"));
    assert.ok(isDangerous("curl http://x | sh"));
  });

  it("blocks end-of-flags, traversal, env-prefix, substitution", () => {
    assert.ok(isDangerous("rm -rf -- /"));
    assert.ok(isDangerous("rm -rf /tmp/../"));
    assert.ok(isDangerous("env sudo ls"));
    assert.ok(isDangerous("echo $(rm -rf /tmp/x)"));
    assert.ok(isDangerous("echo `reboot`"));
  });

  it("allows benign commands", () => {
    assert.equal(isDangerous("ls -la /tmp"), null);
    assert.equal(isDangerous("echo hello"), null);
    assert.equal(isDangerous("rm -rf ./local-dir"), null);
  });
});

describe("M2 unique names (store-backed)", () => {
  it("dedupes against the registry set", () => {
    // Reserved/running maps are shared module state; use a taken registry name.
    const name = testApi.uniqueRunningName("m2-test-base", new Set(["m2-test-base"]));
    assert.equal(name, "m2-test-base-2");
  });
});

describe("C3/M4 atomic ask consume", () => {
  it("delivers once under double-consume", () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    // Atomic-style write like the fixed child does.
    writeFileSync(`${sessionFile}.ask`, JSON.stringify({ name: "w", question: "q?" }));
    const seen: string[] = [];
    const pi = { sendMessage: (m: any) => void seen.push(m.customType) } as any;
    const carrier = { name: "w", agent: "worker", sessionFile, startTime: Date.now() - 4000 };
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), true);
    assert.deepEqual(seen, ["subagent_question"]);
    // Second consumer finds nothing (claimed+unlinked by the first).
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), false);
    assert.equal(seen.length, 1);
    assert.equal(existsSync(`${sessionFile}.ask`), false);
  });

  it("retains torn claims once, then drops (mixed-version gate)", () => {
    // Compat-1: a corrupt claim is retained once for retry (it may be a
    // torn write from a pre-C3 child) and dropped on the second consecutive
    // failure, so a genuinely corrupt file can never loop forever.
    const dir = mkdtempSync(join(tmpdir(), "ask-bad-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    writeFileSync(`${sessionFile}.ask`, "{corrupt");
    const pi = { sendMessage: () => { throw new Error("must not send"); } } as any;
    const carrier = { name: "w", sessionFile, startTime: Date.now() };
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), false);
    assert.equal(existsSync(`${sessionFile}.ask`), true);
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), false);
    assert.equal(existsSync(`${sessionFile}.ask`), false);
  });
});

describe("C1 preamble injection (RCE)", () => {
  it("scriptPreambleFor keeps every line a comment (all fields, all kinds)", async () => {
    const { scriptPreambleFor } = await import("../pi-extension/subagents/launch.ts");
    const evil = "a\ntouch /tmp/pwned\n#";
    for (const kind of ["launch", "resume", "claude-launch"] as const) {
      const pre = scriptPreambleFor(kind, {
        name: evil,
        sessionFile: "/s\nbad",
        surface: "7\nbad",
        resumeMsgFile: "/m\nbad",
      });
      for (const line of pre.split("\n")) {
        assert.ok(line.startsWith("#"), `preamble line must stay a comment: ${line}`);
      }
    }
  });

  it("sink sanitizeScriptPreamble neutralizes non-comment lines (Claude inline path)", async () => {
    const { sanitizeScriptPreamble } = await import("../pi-extension/subagents/kitty.ts");
    // Verbatim shape of the inline Claude preamble with an evil name.
    const raw = [
      "# Claude Code subagent launch script for a",
      "touch /tmp/pwned-from-name",
      "# Surface: 7",
      "",
    ].join("\n");
    const clean = sanitizeScriptPreamble(raw);
    for (const line of clean.split("\n")) {
      assert.ok(
        line.trim() === "" || line.startsWith("#"),
        `sink line must stay a comment: ${line}`,
      );
    }
    assert.ok(!clean.split("\n").some((l) => l === "touch /tmp/pwned-from-name"));
  });
});

describe("H1 tab-death detection", () => {
  it("pollForExit returns an error when the tab is positively gone", async () => {
    const { pollForExit } = await import("../pi-extension/subagents/kitty.ts");
    const ctrl = new AbortController();
    // No sessionFile/sentinel: only the get-text path runs. requireKitty
    // throws (no socket in unit tests), failures accumulate, then the
    // injected probe reports the tab gone.
    const result = await pollForExit("99999", ctrl.signal, {
      interval: 5,
      exists: () => false,
      maxReadFailuresBeforeLivenessProbe: 2,
    });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /closed/);
  });

  it("pollForExit keeps polling on control-plane unknown (N3)", async () => {
    const { pollForExit } = await import("../pi-extension/subagents/kitty.ts");
    const ctrl = new AbortController();
    const done = pollForExit("99999", ctrl.signal, {
      interval: 5,
      exists: () => null,
      maxReadFailuresBeforeLivenessProbe: 2,
    });
    // Abort instead of resolving: unknown must never convert to death.
    setTimeout(() => ctrl.abort(), 40);
    await assert.rejects(done, /Aborted/);
  });
});

describe("H6 resume reservation", () => {
  it("reservation key blocks a second resume for the same name only", () => {
    const reserved = testApi.subagentStore.reserved as Set<string>;
    const key = (artifactDir: string, name: string) => `resume::${artifactDir}::${name}`;
    const k1 = key("/art/aaa", "X");
    const kSame = key("/art/aaa", "X");
    const kOtherName = key("/art/aaa", "Y");
    const kOtherSession = key("/art/bbb", "X");
    assert.equal(reserved.has(k1), false);
    reserved.add(k1);
    try {
      // Second concurrent resume for the same spawner session + name collides.
      assert.equal(reserved.has(kSame), true);
      // Different names / sessions are unaffected (namespaced key).
      assert.equal(reserved.has(kOtherName), false);
      assert.equal(reserved.has(kOtherSession), false);
      // Spawn-time dedupe is unaffected: namespaced keys never equal a
      // display name, so uniqueRunningName ignores them.
      assert.equal(testApi.uniqueRunningName("X", new Set()), "X");
    } finally {
      reserved.delete(k1);
    }
    assert.equal(reserved.has(k1), false);
  });
});

describe("H3 atomic sidecars", () => {
  it("writeCompletionSidecarAtomic round-trips through the parent claim", async () => {
    const mod = await import("../pi-extension/subagents/subagent-done.ts");
    const { __pollForExitTest__ } = await import("../pi-extension/subagents/kitty.ts");
    const dir = mkdtempSync(join(tmpdir(), "h3-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    mod.writeCompletionSidecarAtomic(sessionFile, "exit", {
      type: "error",
      errorMessage: "boom",
      stopReason: "error",
    });
    const result = __pollForExitTest__.takeCompletionSidecar(sessionFile);
    assert.equal(result?.reason, "error");
    assert.equal(result?.errorMessage, "boom");
    assert.equal(existsSync(`${sessionFile}.exit`), false);
  });

  it("writeAskSignalAtomic still round-trips (no regression)", async () => {
    const mod = await import("../pi-extension/subagents/subagent-done.ts");
    const dir = mkdtempSync(join(tmpdir(), "h3-ask-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    mod.writeAskSignalAtomic(sessionFile, { name: "w", question: "q?" });
    assert.ok(existsSync(`${sessionFile}.ask`));
  });
});

describe("M1 done-claim delivers once", () => {
  it("concurrent takeCompletionSidecar on one .done delivers once", async () => {
    const { __pollForExitTest__ } = await import("../pi-extension/subagents/kitty.ts");
    const dir = mkdtempSync(join(tmpdir(), "m1-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    writeFileSync(`${sessionFile}.done`, JSON.stringify({ type: "done" }), "utf8");
    const first = __pollForExitTest__.takeCompletionSidecar(sessionFile);
    const second = __pollForExitTest__.takeCompletionSidecar(sessionFile);
    assert.deepEqual(first, { reason: "done", exitCode: 0 });
    assert.equal(second, null);
    assert.equal(existsSync(`${sessionFile}.done`), false);
  });
});

describe("M4 absent status section", () => {
  it("tabs-only config loads with status defaults", () => {
    assert.deepEqual(parseStatusConfig({ tabs: { keepOpen: true } }, "test"), {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("parseExtensionConfig accepts tabs-only configs", async () => {
    const { parseExtensionConfig } = await import("../pi-extension/subagents/status.ts");
    assert.deepEqual(parseExtensionConfig({ tabs: { keepOpen: true } }), {
      status: { enabled: true, lineLimit: 4 },
      tabs: { keepOpen: true },
    });
  });

  it("present-but-invalid status still throws (loud)", () => {
    assert.throws(() => parseStatusConfig({ status: { enabled: "yes" } }, "test"));
    assert.throws(() => parseStatusConfig({ status: null }, "test"));
  });

  it("getSafeExtensionConfig matches strict config when valid, never throws", async () => {
    const cfg = await import("../pi-extension/subagents/config.ts");
    const safe = cfg.getSafeExtensionConfig();
    assert.equal(typeof safe.status.enabled, "boolean");
    assert.ok(Number.isInteger(safe.status.lineLimit) && safe.status.lineLimit > 0);
    assert.deepEqual(safe, cfg.getExtensionConfig());
  });
});

describe("M5 loadout validation", () => {
  const valid = {
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
  };

  it("accepts the full valid shape", async () => {
    const { isValidSubagentLoadout } = await import("../pi-extension/subagents/session/loadout.ts");
    assert.equal(isValidSubagentLoadout(valid), true);
  });

  it("rejects null/empty/missing allowlists and wrong shapes", async () => {
    const { isValidSubagentLoadout } = await import("../pi-extension/subagents/session/loadout.ts");
    assert.equal(isValidSubagentLoadout({ ...valid, toolAllowlist: null }), false);
    assert.equal(isValidSubagentLoadout({ ...valid, toolAllowlist: "  " }), false);
    assert.equal(isValidSubagentLoadout({ ...valid, toolAllowlist: 42 }), false);
    assert.equal(isValidSubagentLoadout({ ...valid, autoExit: "yes" }), false);
    assert.equal(isValidSubagentLoadout({ ...valid, systemPromptMode: "overwrite" }), false);
    assert.equal(isValidSubagentLoadout({ ...valid, spawnable: "scout" }), false);
    assert.equal(isValidSubagentLoadout(null), false);
    assert.equal(isValidSubagentLoadout([]), false);
  });

  it("readSubagentLoadout refuses a nulled allowlist (never unrestricted)", async () => {
    const { readSubagentLoadout, loadoutSidecarPath } =
      await import("../pi-extension/subagents/session/loadout.ts");
    const { writeFileSync: wfs } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "m5-"));
    const sf = join(dir, "s.jsonl");
    wfs(sf, JSON.stringify({ type: "session", id: "s" }) + "\n");
    wfs(loadoutSidecarPath(sf), JSON.stringify({ ...valid, toolAllowlist: null }));
    assert.equal(readSubagentLoadout(sf), null);
  });
});

describe("M6 registry backup", () => {
  it("backs up corrupt registries instead of clobbering", async () => {
    const { registerName, readNameRegistry, nameRegistryPath } =
      await import("../pi-extension/subagents/session/registry.ts");
    const { readdirSync: rds, readFileSync: rfs } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "m6-"));
    registerName(dir, "a", { sessionFile: "/a.jsonl", sessionId: "1" });
    writeFileSync(nameRegistryPath(dir), "{torn");
    registerName(dir, "b", { sessionFile: "/b.jsonl", sessionId: "2" });
    assert.equal(readNameRegistry(dir).b?.sessionId, "2");
    const backups = rds(dir).filter((f) => f.startsWith("subagent-registry.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(rfs(join(dir, backups[0]), "utf8"), "{torn");
  });

  it("merges salvageable entries from partially-valid registries", async () => {
    const { registerName, readNameRegistry, nameRegistryPath } =
      await import("../pi-extension/subagents/session/registry.ts");
    const dir = mkdtempSync(join(tmpdir(), "m6-salvage-"));
    writeFileSync(
      nameRegistryPath(dir),
      JSON.stringify({ good: { sessionFile: "/g.jsonl", sessionId: "g" }, bad: { sessionId: 42 } }),
    );
    registerName(dir, "new", { sessionFile: "/n.jsonl", sessionId: "n" });
    const reg = readNameRegistry(dir);
    assert.equal(reg.good?.sessionId, "g");
    assert.equal(reg.new?.sessionId, "n");
    assert.equal("bad" in reg, false);
  });
});

describe("M8 tool registry survives reload", () => {
  it("backing map lives on a Symbol.for global", async () => {
    const agents = await import("../pi-extension/subagents/agents.ts");
    agents.__clearToolExtensionsForTest();
    try {
      agents.registerToolExtension("m8_tool", "/ext/path.ts");
      assert.equal(agents.getToolExtensionPath("m8_tool"), "/ext/path.ts");
      // A /reload re-import resets module-locals; the Symbol.for map persists.
      const backing = (globalThis as any)[Symbol.for("pi-subagents/tool-extensions")];
      assert.ok(backing instanceof Map);
      assert.equal(backing.get("m8_tool"), "/ext/path.ts");
    } finally {
      agents.__clearToolExtensionsForTest();
    }
    assert.equal(agents.getToolExtensionPath("m8_tool"), undefined);
  });
});

describe("M2 no-clobber claim restore", () => {
  it("queues the held payload and drains it after the newer question", async () => {
    const { renameSync, readFileSync: rfs } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "m2-"));
    const sessionFile = join(dir, "s.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s" }) + "\n");
    const askFile = `${sessionFile}.ask`;
    writeFileSync(askFile, JSON.stringify({ name: "w", question: "Q1" }));
    // Simulate the race: Q1 claimed, then the child asks Q2.
    const claim = `${askFile}.testclaim`;
    renameSync(askFile, claim);
    writeFileSync(askFile, JSON.stringify({ name: "w", question: "Q2" }));
    assert.equal(testApi.restoreAskClaimNoClobber(claim, askFile), "kept-newer");
    assert.equal(JSON.parse(rfs(askFile, "utf8")).question, "Q2");
    // Q2 delivers first; the parked Q1 drains on the next tick.
    const seen: string[] = [];
    const pi = { sendMessage: (m: any) => void seen.push(m.content) } as any;
    const carrier = { name: "w", agent: "worker", sessionFile, startTime: Date.now() - 1000 };
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), true);
    assert.match(seen[0], /Q2/);
    assert.equal(testApi.deliverPendingQuestion(carrier, pi), true);
    assert.match(seen[1], /Q1/);
    assert.equal(existsSync(askFile), false);
  });
});

describe("M3 cancelled-notify gate", () => {
  it("cancelled results never notify; real errors always do", () => {
    assert.equal(testApi.shouldNotifyResult({ error: "cancelled" }), false);
    assert.equal(testApi.shouldNotifyResult({} as any), true);
    assert.equal(testApi.shouldNotifyResult({ error: "boom" } as any), true);
  });
});

describe("M7 resume baseline on parsed-entry basis", () => {
  it("torn lines before the resume point don't shift the window", async () => {
    const { readEntriesAfter, getNewEntries } =
      await import("../pi-extension/subagents/session/io.ts");
    const sid = JSON.stringify({ type: "session", id: "s" });
    const m1 = JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } });
    const m2 = JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "two" }] } });
    const m3 = JSON.stringify({ type: "message", id: "m3", message: { role: "assistant", content: [{ type: "text", text: "three" }] } });
    const f = sessionFileWithRaw([sid, m1, "{torn line", m2].join("\n") + "\n");
    // Parsed-length basis (what the resume path now stores).
    const base = readEntriesAfter(f, 0);
    const baseline = base.total - (base.skipped ?? 0);
    assert.equal(baseline, 3);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(f, m3 + "\n");
    assert.deepEqual(
      getNewEntries(f, baseline).map((e: any) => e.id),
      ["m3"],
    );
    // The old raw-line-count basis overshoots by the torn count and misses m3.
    assert.deepEqual(getNewEntries(f, base.total).map((e: any) => e.id), []);
  });
});

describe("M9 kept monitor ignores second .done", () => {
  it("takeCompletionSidecar with ignoreDone leaves .done alone", async () => {
    const { __pollForExitTest__ } = await import("../pi-extension/subagents/kitty.ts");
    const dir = mkdtempSync(join(tmpdir(), "m9-"));
    const sf = join(dir, "s.jsonl");
    writeFileSync(sf, JSON.stringify({ type: "session", id: "s" }) + "\n");
    writeFileSync(`${sf}.done`, JSON.stringify({ type: "done" }), "utf8");
    assert.equal(__pollForExitTest__.takeCompletionSidecar(sf, { ignoreDone: true }), null);
    assert.equal(existsSync(`${sf}.done`), true);
    assert.deepEqual(__pollForExitTest__.takeCompletionSidecar(sf), { reason: "done", exitCode: 0 });
  });

  it("still reports .exit errors with ignoreDone set", async () => {
    const { __pollForExitTest__ } = await import("../pi-extension/subagents/kitty.ts");
    const dir = mkdtempSync(join(tmpdir(), "m9-exit-"));
    const sf = join(dir, "s.jsonl");
    writeFileSync(sf, JSON.stringify({ type: "session", id: "s" }) + "\n");
    writeFileSync(`${sf}.done`, JSON.stringify({ type: "done" }), "utf8");
    writeFileSync(`${sf}.exit`, JSON.stringify({ type: "error", errorMessage: "late failure" }), "utf8");
    const result = __pollForExitTest__.takeCompletionSidecar(sf, { ignoreDone: true });
    assert.equal(result?.reason, "error");
    assert.equal(result?.errorMessage, "late failure");
  });
});

// ── H4/H5 lifecycle harnesses ────────────────────────────────────────────────

function mockExtensionApi() {
  const handlers: Record<string, Function[]> = {};
  return {
    api: {
      on: (e: string, h: Function) => void ((handlers[e] ??= []).push(h)),
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      getAllTools: () => [],
    } as any,
    handlers,
  };
}

function mockSessionCtx(dir: string, sid: string, calls: string[] = []) {
  return {
    hasUI: true,
    ui: { setWidget: (...a: any[]) => void calls.push(a[0]), notify: () => {} },
    sessionManager: {
      getSessionDir: () => dir,
      getSessionId: () => sid,
      getSessionFile: () => join(dir, "parent.jsonl"),
    },
  } as any;
}

describe("H4 per-session timers", () => {
  it("shutdown of one session keeps the survivor's timers; last shutdown clears", async () => {
    const subagents = await import("../pi-extension/subagents/index.ts");
    const { getArtifactDir } = await import("../pi-extension/subagents/paths.ts");
    const { createStatusState } = await import("../pi-extension/subagents/status.ts");
    const dirA = mkdtempSync(join(tmpdir(), "h4-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "h4-b-"));
    const artA = getArtifactDir(dirA, "sessA");
    const artB = getArtifactDir(dirB, "sessB");
    const { api: apiA, handlers: hA } = mockExtensionApi();
    const { api: apiB, handlers: hB } = mockExtensionApi();
    (subagents as any).default(apiA);
    (subagents as any).default(apiB);
    const running = testApi.runningSubagents as Map<string, any>;
    const ctxs = testApi.sessionCtxs as Map<string, any>;
    const startA = hA["session_start"][0];
    const shutA = hA["session_shutdown"][0];
    const shutB = hB["session_shutdown"][0];
    const now = Date.now();
    try {
      startA(undefined, mockSessionCtx(dirA, "sessA"));
      hB["session_start"][0](undefined, mockSessionCtx(dirB, "sessB"));
      assert.ok(ctxs.has(artA) && ctxs.has(artB));
      running.set("h4-run", {
        id: "h4-run",
        name: "H4",
        task: "t",
        surface: "1",
        startTime: now,
        sessionFile: join(dirA, "s.jsonl"),
        parentArtifactDir: artA,
        abortController: new AbortController(),
        cli: "claude",
        statusState: createStatusState({ source: "claude", startTimeMs: now }),
      });
      testApi.startWidgetRefresh();
      testApi.startStatusRefresh({ sendMessage: () => {} });
      assert.deepEqual(testApi.timersActiveForTest(), { widget: true, status: true });
      shutB(undefined, mockSessionCtx(dirB, "sessB"));
      assert.ok(running.has("h4-run"), "survivor run untouched");
      assert.ok(!ctxs.has(artB) && ctxs.has(artA), "only the shutting session forgotten");
      assert.deepEqual(testApi.timersActiveForTest(), { widget: true, status: true });
      shutA(undefined, mockSessionCtx(dirA, "sessA"));
      assert.ok(!running.has("h4-run"), "own runs torn down");
      assert.deepEqual(testApi.timersActiveForTest(), { widget: false, status: false });
    } finally {
      running.delete("h4-run");
      try { shutA(undefined, mockSessionCtx(dirA, "sessA")); } catch {}
      try { shutB(undefined, mockSessionCtx(dirB, "sessB")); } catch {}
    }
  });
});

describe("H5 reload resurrection", () => {
  it("decides watch/prune/skip from tracked/kept/liveness (tri-state)", () => {
    const decide = testApi.decideResurrectAction;
    assert.equal(decide({ tracked: true, kept: false, alive: true }), "skip");
    assert.equal(decide({ tracked: false, kept: true, alive: true }), "skip");
    assert.equal(decide({ tracked: false, kept: false, alive: false }), "prune");
    // Unknown control plane watches rather than orphaning (N3).
    assert.equal(decide({ tracked: false, kept: false, alive: null }), "watch");
    assert.equal(decide({ tracked: false, kept: false, alive: true }), "watch");
  });

  it("session_start settles orphans: watches live tabs, prunes dead surfaces", async () => {
    // Environment-adaptive: without kitty remote control, liveness is
    // unknown so the orphan is re-watched (assert registration + clean
    // abort); with a live control plane, surface 99999 is positively dead
    // so the dead surface is pruned for resume-by-name (assert registry).
    // Both are correct H5 behavior — a live tab must never end ownerless.
    const subagents = await import("../pi-extension/subagents/index.ts");
    const { getArtifactDir } = await import("../pi-extension/subagents/paths.ts");
    const { registerName, readNameRegistry } =
      await import("../pi-extension/subagents/session/registry.ts");
    const dir = mkdtempSync(join(tmpdir(), "h5-"));
    const sid = "sessH5";
    const art = getArtifactDir(dir, sid);
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "c1" }) + "\n");
    const { api, handlers } = mockExtensionApi();
    (subagents as any).default(api);
    registerName(art, "Orphan", { sessionFile, sessionId: "c1", surface: "99999", running: true });
    const running = testApi.runningSubagents as Map<string, any>;
    const start = handlers["session_start"][0];
    const shut = handlers["session_shutdown"][0];
    const ctx = mockSessionCtx(dir, sid);
    try {
      start(undefined, ctx);
      await new Promise((r) => setTimeout(r, 25));
      const entry = [...running.values()].find((r: any) => r.name === "Orphan");
      if (entry) {
        // Watch path (liveness unknown): live tab re-watched.
        assert.equal(entry.surface, "99999");
        entry.abortController.abort();
        await new Promise((r) => setTimeout(r, 75));
        assert.ok(
          ![...running.values()].some((r: any) => r.name === "Orphan"),
          "aborted watcher cleans up without notifying",
        );
      } else {
        // Prune path (positively dead): surface cleared for resume-by-name.
        const reg = readNameRegistry(art)["Orphan"] as any;
        assert.ok(reg, "registry handle preserved");
        assert.equal(reg.surface, undefined);
        assert.equal(reg.sessionFile, sessionFile);
      }
    } finally {
      for (const [id, r] of [...running]) {
        if ((r as any).name === "Orphan") running.delete(id);
      }
      try { shut(undefined, ctx); } catch {}
    }
  });
});
