/**
 * Phase 6 — handlers + lifecycle (T5/P1/P2, S6/S7/S8, T8).
 * New suites import homes directly (M3 rule — no new `__test__` keys).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── T5 validators (pure, direct home imports) ──────────────────────────────
describe("validators: self-spawn + allowlist gating + name/cwd", () => {
  it("validateSelfSpawn blocks only exact self-spawn", async () => {
    const { validateSelfSpawn } = await import("../pi-extension/subagents/handlers/validators.ts");
    const blocked = validateSelfSpawn("worker", "worker");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.details.error, "self-spawn blocked");
    assert.equal(validateSelfSpawn("scout", "worker").ok, true);
    assert.equal(validateSelfSpawn("worker", undefined).ok, true);
    assert.equal(validateSelfSpawn(undefined, "worker").ok, true);
  });

  it("validateSpawnParams requires a permitted agent", async () => {
    const { validateSpawnParams } = await import("../pi-extension/subagents/handlers/validators.ts");
    // Missing agent (unrestricted: discoverable list shown).
    const missing = validateSpawnParams({}, { allowlisted: null, discoverable: ["scout", "w"] });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.details.error, "agent required");
      assert.match(missing.text, /scout, w/);
    }
    // Unknown agent when unrestricted.
    const unknown = validateSpawnParams(
      { agent: "nope" },
      { allowlisted: null, discoverable: ["scout"] },
    );
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.details.error, "unknown agent");
    // Restricted allowlist: pinned-out agent refused with allowlist wording.
    const denied = validateSpawnParams(
      { agent: "worker" },
      { allowlisted: new Set(["scout"]), discoverable: ["scout", "worker"] },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.details.error, "agent not in allowlist");
      assert.match(denied.text, /not in your allowlist/);
    }
    // Pinned agent passes.
    const ok = validateSpawnParams(
      { agent: "scout" },
      { allowlisted: new Set(["scout"]), discoverable: ["scout", "worker"] },
    );
    assert.equal(ok.ok, true);
  });

  it("validateNameCwd rejects control characters (C1 boundary)", async () => {
    const { validateNameCwd } = await import("../pi-extension/subagents/handlers/validators.ts");
    assert.equal(validateNameCwd({ name: "ok", cwd: "/tmp/x" }).ok, true);
    const badName = validateNameCwd({ name: "a\n evil" });
    assert.equal(badName.ok, false);
    if (!badName.ok) assert.equal(badName.details.error, "invalid name");
    const badCwd = validateNameCwd({ cwd: "a\0b" });
    assert.equal(badCwd.ok, false);
    if (!badCwd.ok) assert.equal(badCwd.details.error, "invalid cwd");
  });

  it("decideSteerResume: steer vs resume-fallthrough vs ambiguity-error", async () => {
    const { decideSteerResume } = await import("../pi-extension/subagents/handlers/validators.ts");
    assert.deepEqual(decideSteerResume({ running: { name: "w" } }), { kind: "steer" });
    assert.deepEqual(
      decideSteerResume({ error: 'No running subagent named "w". No subagents are currently running.' }),
      { kind: "resume" },
    );
    const amb = decideSteerResume({ error: 'Ambiguous subagent name "w". Matches: w [a], w [b]' });
    assert.equal(amb.kind, "error");
    if (amb.kind === "error") assert.match(amb.text, /Ambiguous/);
  });

  it("loadout/missing-file refusal wordings name the session", async () => {
    const { loadoutRefusalText, missingSessionFileText } =
      await import("../pi-extension/subagents/handlers/validators.ts");
    assert.match(loadoutRefusalText("w"), /Cannot safely resume "w"/);
    assert.match(loadoutRefusalText("w"), /sandbox snapshot/);
    assert.match(missingSessionFileText("w", "/gone.jsonl"), /"w".*\/gone\.jsonl/);
  });
});

// ── P1: teardownSession scoping (M1/M5, fake store) ─────────────────────────
describe("teardownSession is scoped per spawner session (M1)", () => {
  it("aborts only the shutting-down dir's runs, keeps survivors' timers", async () => {
    const { SubagentStore } = await import("../pi-extension/subagents/store.ts");
    const { teardownSession, timersActiveForTest } = await import("../pi-extension/subagents/lifecycle.ts");
    const store = new SubagentStore();
    const dirA = join(tmpdir(), `exactA-${Date.now()}`);
    const dirB = join(tmpdir(), `exactB-${Date.now()}`);
    const abortA = new AbortController();
    const abortB = new AbortController();
    store.running.set("a1", { id: "a1", name: "a", sessionFile: "s", surface: "1", parentArtifactDir: dirA, abortController: abortA } as any);
    store.running.set("b1", { id: "b1", name: "b", sessionFile: "s", surface: "2", parentArtifactDir: dirB, abortController: abortB } as any);
    store.kept.set(`${dirA}::ka`, { name: "ka", surface: "3", sessionFile: "s", sessionId: null, parentArtifactDir: dirA, abort: new AbortController(), startTime: 0 } as any);

    teardownSession(store, dirA);

    assert.equal(store.running.has("a1"), false, "dirA run dropped");
    assert.equal(abortA.signal.aborted, true, "dirA watcher aborted");
    assert.equal(store.running.has("b1"), true, "dirB run survives");
    assert.equal(abortB.signal.aborted, false, "dirB watcher untouched");
    assert.equal(store.kept.size, 0, "dirA kept tab dropped");
    assert.equal(timersActiveForTest().widget, false, "no timers were armed");
    // Legacy fallback: null dir aborts everything left.
    teardownSession(store, null);
    assert.equal(store.running.size, 0);
    assert.equal(abortB.signal.aborted, true);
  });
});

// ── P1: recoverSession ask-recovery + kept reattach (fake store, no kitty) ──
describe("recoverSession recovers asks + kept tabs + live runs", () => {
  it("delivers orphaned .ask, reattaches kept, rewatches live, prunes dead", async () => {
    const { SubagentStore } = await import("../pi-extension/subagents/store.ts");
    const { recoverSession, teardownSession } =
      await import("../pi-extension/subagents/lifecycle.ts");
    const { registerName, readNameRegistry } =
      await import("../pi-extension/subagents/session/registry.ts");
    const dir = mkdtempSync(join(tmpdir(), "recover-"));
    const art = join(dir, "artifacts", "sess1");
    mkdirSync(art, { recursive: true });

    // (a) orphaned .ask: session file gone, .ask present.
    const askSession = join(art, "q.jsonl");
    writeFileSync(`${askSession}.ask`, JSON.stringify({ question: "blocked on X?" }));
    registerName(art, "asker", { sessionFile: askSession, sessionId: null });
    // (b) kept tab, session file present, tab alive.
    const keptSession = join(art, "k.jsonl");
    writeFileSync(keptSession, JSON.stringify({ type: "session", id: "k" }) + "\n");
    registerName(art, "kept", { sessionFile: keptSession, sessionId: "k", surface: "9001" });
    // (c) live run, control-plane unknown → rewatch.
    const liveSession = join(art, "live.jsonl");
    writeFileSync(liveSession, JSON.stringify({ type: "session", id: "l" }) + "\n");
    registerName(art, "live", { sessionFile: liveSession, sessionId: "l", surface: "9002", running: true });
    // (d) live run, tab positively gone → prune surface.
    const deadSession = join(art, "dead.jsonl");
    writeFileSync(deadSession, JSON.stringify({ type: "session", id: "d" }) + "\n");
    registerName(art, "dead", { sessionFile: deadSession, sessionId: "d", surface: "9003", running: true });

    const store = new SubagentStore();
    const sent: any[] = [];
    const pi = { sendMessage: (m: any, o: any) => void sent.push([m, o]) } as any;
    const monitored: string[] = [];
    const watched: string[] = [];
    const exists = (s: string) => (s === "9003" ? false : s === "9002" ? null : true);

    recoverSession(store, art, pi, {
      exists,
      monitorKept: (kept) => void monitored.push(kept.name),
      watchRunning: (running) => void watched.push(running.name),
    });

    // (a) orphaned question delivered exactly once.
    assert.equal(sent.length, 1, `one question, got ${sent.length}`);
    assert.equal(sent[0][0].customType, "subagent_question");
    assert.match(sent[0][0].content, /blocked on X\?/);
    assert.equal(existsSync(`${askSession}.ask`), false, ".ask consumed");
    // (b) kept tab reattached (not swallowed as a run).
    assert.deepEqual(monitored, ["kept"]);
    assert.ok(store.kept.has(`${art}::kept`), "kept tracked in the passed store");
    // (c) live run rewatched, never double (N3 unknown ⇒ watch, not prune).
    assert.deepEqual(watched, ["live"]);
    assert.equal(store.running.size, 1);
    // (d) dead surface pruned so resume-by-name works.
    assert.equal(readNameRegistry(art)["dead"]?.surface, undefined, "dead surface cleared");

    // Cleanup: resurrected entries armed real refresh timers — stand them down.
    store.running.clear();
    store.kept.clear();
    teardownSession(store, null);
  });
});

// ── T8: session/sidecars.ts policy + dependency-free ────────────────────────
describe("session/sidecars.ts primitives", () => {
  it("is dependency-free (node:fs/path only — child-safe)", async () => {
    const root = new URL("../pi-extension/subagents/session/", import.meta.url);
    const src = readFileSync(new URL("sidecars.ts", root), "utf8");
    const imports = src.split("\n").filter((l) => l.trim().startsWith("import "));
    assert.ok(imports.length > 0, "has imports");
    for (const line of imports) {
      assert.ok(/from\s+["']node:(fs|path)["']/.test(line), `dependency-free import: ${line}`);
    }
  });

  it("atomicWriteJson + claimFile + readJsonClaim round-trip", async () => {
    const { atomicWriteJson, claimFile, readJsonClaim } =
      await import("../pi-extension/subagents/session/sidecars.ts");
    const dir = mkdtempSync(join(tmpdir(), "side-"));
    const target = join(dir, "s.json");
    atomicWriteJson(target, { a: 1 });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { a: 1 });
    assert.equal(claimFile(join(dir, "missing")), null, "absent ⇒ null");
    const claim = claimFile(target);
    assert.ok(claim, "claim path returned");
    assert.equal(existsSync(target), false, "original moved");
    assert.equal(claimFile(target), null, "second claim loses the race");
    const read = readJsonClaim<{ a: number }>(claim!);
    assert.deepEqual(read, { ok: true, value: { a: 1 } });
    assert.equal(existsSync(claim!), false, "claim consumed");
    // Corrupt claim is consumed, never retried.
    writeFileSync(target, "{torn");
    const corruptClaim = claimFile(target)!;
    assert.deepEqual(readJsonClaim(corruptClaim), { ok: false });
    assert.equal(existsSync(corruptClaim), false, "corrupt claim consumed");
  });

  it("takeSidecar: .exit wins, claims both, corrupt .exit consumed with report", async () => {
    const { takeSidecar } = await import("../pi-extension/subagents/session/sidecars.ts");
    const dir = mkdtempSync(join(tmpdir(), "take-"));
    const sf = join(dir, "s.jsonl");
    writeFileSync(sf, "x\n");
    // .done alone.
    writeFileSync(`${sf}.done`, JSON.stringify({ type: "done" }));
    assert.deepEqual(takeSidecar(sf), { reason: "done", exitCode: 0 });
    assert.equal(takeSidecar(sf), null, "fires once");
    // .exit wins over .done.
    writeFileSync(`${sf}.done`, JSON.stringify({ type: "done" }));
    writeFileSync(`${sf}.exit`, JSON.stringify({ type: "error", errorMessage: "boom" }));
    assert.deepEqual(takeSidecar(sf), { reason: "error", exitCode: 1, errorMessage: "boom" });
    assert.equal(existsSync(`${sf}.done`), true, ".done left for the next take");
    assert.deepEqual(takeSidecar(sf), { reason: "done", exitCode: 0 });
    // ignoreDone (M9 kept monitors).
    writeFileSync(`${sf}.done`, JSON.stringify({ type: "done" }));
    assert.equal(takeSidecar(sf, { ignoreDone: true }), null);
    assert.equal(existsSync(`${sf}.done`), true, "ignored .done left alone");
    // Corrupt .exit consumed (not retried) + reported, falls through to .done.
    const corrupts: string[] = [];
    writeFileSync(`${sf}.exit`, "{torn");
    const fell = takeSidecar(sf, { onCorrupt: (k, _p, r) => void corrupts.push(`${k}:${r}`) });
    assert.deepEqual(fell, { reason: "done", exitCode: 0 });
    assert.deepEqual(corrupts, ["exit-sidecar:torn-json-consumed"]);
    assert.equal(existsSync(`${sf}.exit`), false, "corrupt .exit consumed");
  });
});

// ── S6/S7/S8 ────────────────────────────────────────────────────────────────
describe("S6 launch-types.ts deleted, launch.ts imports agents.ts", () => {
  it("shim file gone, no references remain", async () => {
    const root = new URL("../pi-extension/subagents/", import.meta.url);
    assert.equal(existsSync(new URL("launch-types.ts", root)), false, "launch-types.ts deleted");
    const launchSrc = readFileSync(new URL("launch.ts", root), "utf8");
    assert.ok(!launchSrc.includes('from "./launch-types'), "no shim import");
    assert.ok(launchSrc.includes('from "./agents.ts"'), "imports agents.ts directly");
  });
});

describe("S7 frontmatter parsed once into a Map", () => {
  it("parseFrontmatterBlock agrees with the wrapper (incl. CRLF + empties)", async () => {
    const { parseFrontmatterBlock, getFrontmatterValue } =
      await import("../pi-extension/subagents/agents.ts");
    const block = "name: w\r\nmodel: m1\r\nempty:\r\nsubagent_agents: a, b";
    const map = parseFrontmatterBlock(block);
    assert.equal(map.get("name"), "w");
    assert.equal(map.get("model"), "m1");
    assert.equal(map.get("subagent_agents"), "a, b");
    // Wrapper preserves the old `(.+)` contract: empties ⇒ undefined.
    assert.equal(getFrontmatterValue(block, "name"), "w");
    assert.equal(getFrontmatterValue(block, "empty"), undefined);
    assert.equal(getFrontmatterValue(block, "missing"), undefined);
  });

  it("bundled worker parses identically (list gate + auto-exit intact)", async () => {
    const { getBundledAgentsDir, parseAgentDefinition } =
      await import("../pi-extension/subagents/agents.ts");
    // Read the bundled file directly (a global ~/.pi/agent/agents/*.md may
    // shadow it in this environment — ruefully covered by AGENTS.md).
    const raw = readFileSync(join(getBundledAgentsDir(), "worker.md"), "utf8");
    const def = parseAgentDefinition(raw, "worker")!;
    assert.deepEqual(def.subagentAgents, ["scout", "researcher"]);
    assert.equal(def.autoExit, true);
  });
});

describe("S8 resolveLaunchPolicy table + deprecated aliases", () => {
  it("one table drives all arms", async () => {
    const { resolveLaunchPolicy } = await import("../pi-extension/subagents/agents.ts");
    assert.deepEqual(resolveLaunchPolicy(null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
      interactive: true,
    });
    assert.deepEqual(resolveLaunchPolicy({ sessionMode: "fork" }), {
      sessionMode: "fork",
      seededSessionMode: "fork",
      inheritsConversationContext: true,
      taskDelivery: "direct",
      interactive: true,
    });
    assert.deepEqual(resolveLaunchPolicy({ sessionMode: "lineage-only", autoExit: true }), {
      sessionMode: "lineage-only",
      seededSessionMode: "lineage-only",
      inheritsConversationContext: false,
      taskDelivery: "artifact",
      interactive: false,
    });
    // Explicit interactive wins over the auto-exit default.
    assert.equal(
      resolveLaunchPolicy({ autoExit: true, interactive: true }).interactive,
      true,
    );
  });

  it("deprecated aliases delegate (shapes pinned by test/test.ts)", async () => {
    const {
      resolveLaunchPolicy,
      resolveEffectiveSessionMode,
      resolveLaunchBehavior,
      resolveEffectiveInteractive,
    } = await import("../pi-extension/subagents/agents.ts");
    const defs = { sessionMode: "fork", autoExit: true, interactive: false } as any;
    const policy = resolveLaunchPolicy(defs);
    assert.equal(resolveEffectiveSessionMode({}, defs), policy.sessionMode);
    assert.deepEqual(resolveLaunchBehavior({}, defs), {
      sessionMode: policy.sessionMode,
      seededSessionMode: policy.seededSessionMode,
      inheritsConversationContext: policy.inheritsConversationContext,
      taskDelivery: policy.taskDelivery,
    });
    assert.equal(resolveEffectiveInteractive({}, defs), policy.interactive);
  });
});
