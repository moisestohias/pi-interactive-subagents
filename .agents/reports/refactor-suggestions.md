# Refactor / Simplification Suggestions

Scope: `pi-extension/subagents/` as of v3.7.2 (`index.ts` ~2629 lines). Read: `AGENTS.md`, `index.ts`, and all canonical modules listed there. No source was edited.

---

# Summary

The R1–R11 extraction program worked: every concern now *has* a canonical home (`launch.ts`, `store.ts`, `notifications.ts`, `widget.ts`, `format.ts`, `keep.ts`, `config.ts`, `status-bridge.ts`, `session/*`, `subagent-done-pure.ts`, `kitty.ts`, `names.ts`/`paths.ts`). What remains is a **migration-completion problem**, not an architecture problem:

1. **`index.ts` did not get thinner — it got wider.** ~40 delegating wrappers (~lines 233–830) re-export the canonical modules line-for-line so `__test__` keeps working. They are now the largest single block in the file and re-introduce the exact "second builder / second formatter / second label" hazard AGENTS.md rule 1 forbids.
2. **The two biggest behaviors never moved out.** `launchSubagent` (~1015–1326), the `subagent` execute handler (~1696–1980), the `subagent_message` execute handler (~2044–2400, incl. the full resume assembler ~2200–2380), `watchSubagent` (~1448–1590), the three message renderers (~2400–2629), and the `session_start`/`session_shutdown` lifecycle blocks (~1592–1695) are still inline in `index.ts`. Together they are ~1500 lines — more than all canonical modules combined.
3. **Launch assembly already drifted.** `launch.ts` owns `buildEnvPrefix`, `SCRUB_PREFIX`, `writeTaskArtifact`, `writeResumeMessageFile`, `buildPiParts`, `scriptPreambleFor` — but `launchSubagent` and the resume path rebuild env/task/scrub/preamble inline instead of calling them. That is a live rule-1 violation with byte-identical-output risk, exactly the class AGENTS.md warns about.
4. **Three modules are doing 2–3 jobs each** (`status.ts` = config-parse + state-machine + formatting, 564 lines; `activity.ts` = validation + recorder + file IO, 511 lines; `kitty.ts` = availability + terminal IO + sidecar protocol + poll loop, 475 lines). Each splits cleanly along existing seams.
5. **Sidecar/claim primitives are copy-pasted 4×** (`takeCompletionSidecar` in `kitty.ts`, `claimAskFile` in `index.ts`, `writeAskSignalAtomic` in `subagent-done.ts`, tmp+rename in `session/registry.ts` + `activity.ts`). One `sidecars.ts` removes a whole bug class (partial-flush reads, double-fire, poison-on-corrupt).

Net opportunity: delete ~500–700 lines of wrappers/duplication, move ~1300 lines into 4–5 focused modules with no behavior change, and leave `index.ts` at ~300–400 lines of pure registration (`registerTool` × 3, `registerCommand` × 1, `registerMessageRenderer` × 3, `on(session_start|shutdown)` × 2, each delegating to a handler module). Every step below is snapshot-testable byte-identical first, per AGENTS.md rule 2.

---

# Top simplifications (prioritized, with file:line refs and why)

## T1. Delete the ~40 delegating wrappers in `index.ts` (biggest single win)

- **Current location:** `pi-extension/subagents/index.ts:233–830` — `getAgentConfigDir`, `getToolExtensionPath`, `getSubagentAllowlistFresh`, `getBundledAgentsDir`, `getFrontmatterValue`, `parseOptionalBoolean`, `parseCommaList`, `parseSubagentAgents`, `canSpawnSubagents`, `parseSessionMode`, `parseAgentDefinition`, `discoverAgentDefinitions`, `resolveSubagentPaths`, `getDefaultSessionDirFor`, `resolveEffectiveSessionMode`, `resolveLaunchBehavior`, `resolveEffectiveInteractive`, `loadAgentDefaults` (233–323); `formatElapsed`, `formatTokens`, `contextWindowFor`, `formatContextUsage`, `formatUsageSegments` (325–357); `widgetIcon` (360–367); `shouldKeepSurface*`, `resolveKeepDecision`, `maybeCloseSurface` (398–426); `getArtifactDir` (448–450); `formatWidgetRightLabel`, `resolveResultPresentation` (480–500); `keptKey`, `keptTabAlive`, `findKeptTab`, `trackKeptTab`, `monitorKeptTab` (580–674); `borderLine/Top/Bottom`, `renderSubagentWidgetLines`, `updateWidget` stays but `border*` wrappers (685–713) duplicate `widget.ts`; `buildSubagentToolAllowlist`, `applySandboxToParts`, `buildPiPromptArgs` (761–789); `activityLabel`, `observeRunningSubagent` (787–814); `uniqueRunningName`, `resolveRunningByName`, `steerSubagent`, `handleSubagentSteer` (816–892); plus `copyClaudeSession` (1327–1330) and the `__test__` map (952–999) that exists only to serve these wrappers.
- **Problem:** every wrapper is a second name for a canonical function with zero added logic. Call sites inside `index.ts` call the wrapper, not the canonical import (which is already imported as `*Canonical`). This doubles the rename/refactor surface, hides the real dependency graph, and teaches new code to add "just one more wrapper" instead of importing the home module. The `ICON_*`/`ACCENT`/`RST` constants are additionally duplicated: `index.ts:353–357,677–678` vs `widget.ts:10–16`.
- **Proposed shape:** mechanical, zero-behavior:
  1. At each internal call site, replace `foo(...)` with `fooCanonical(...)` (the import already exists).
  2. Delete the wrapper function.
  3. Re-point `__test__` (952–999) directly at the canonical imports: `borderLine: borderLineCanonical, …` instead of via locals. `test/test.ts` imports only through `__test__` (see `test/test.ts:1159,1300,…`), so no test changes are needed.
  4. Delete the duplicated color constants in `index.ts`; import `ACCENT/RST/ICON_*` from `widget.ts` where still needed (only the renderers need them).
  ```ts
  // before (index.ts:325-327)
  function formatElapsed(seconds: number): string {
    return formatElapsedCanonical(seconds);
  }
  // after: delete; call sites use formatElapsedCanonical directly.
  // __test__ before:  formatElapsed,
  // __test__ after:   formatElapsed: formatElapsedCanonical,
  ```
- **Benefit:** −350 to −450 lines in `index.ts`; AGENTS.md rule 1 becomes mechanically enforceable (grep for `Canonical` alias vs. local `function` of the same name); renames in a home module propagate instead of silently shadowing.

## T2. Make `launchSubagent` actually use `launch.ts` (live second-builder drift)

- **Current location:** launch path `index.ts:1015–1326` vs. canonical builders in `launch.ts:21–227`.
- **Problem:** four canonical helpers exist but the launch path bypasses them:
  | Concern | Canonical (unused here) | Inline duplicate in `index.ts` |
  |---|---|---|
  | Env prefix | `buildEnvPrefix` (`launch.ts:50–66`, key order pinned for snapshots) | hand-built `envParts` (`index.ts:1217–1244`) — same keys, different construction site; any key-order or new-var change must be made twice |
  | Legacy scrub | `SCRUB_PREFIX` (`launch.ts:26`) | hardcoded `"unset PI_SUBAGENT_KEEP_TAB; "` (`index.ts:1277`) |
  | Task artifact | `writeTaskArtifact` (`launch.ts:174–188`) | inline `artifactName/artifactPath/writeFileSync` (`index.ts:1254–1259`) |
  | Pi command | `buildPiParts` (`launch.ts:211–225`) | inline `parts` assembly (`index.ts:1196–1269`) |
  | Claude preamble | `scriptPreambleFor` (`launch.ts:68–81`) | hand-built 3-line array (`index.ts:1136–1140`); the pi path *does* use `scriptPreambleForCanonical` (1285) — so the two backends already disagree |
  | Resume file | `writeResumeMessageFile` (`launch.ts:189–201`) | inline `resumeMsgFile` block (`index.ts:2262–2272`) |
  | Timestamp tag | — (no home; see S3) | `new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)` at `launch.ts:102,180,190` + `index.ts:1254,2264` (+ a 23-char variant at `index.ts:1044`) |
- **Proposed shape:** keep `launchSubagent` as the orchestrator (id/cwd/session-file/surface acquisition + store registration) but delegate assembly:
  ```ts
  // launch.ts — new: single plan builder both launch and resume use
  export interface LaunchPlan {
    parts: string[]; envPrefix: string; cdPrefix: string;
    command: string; scriptFile: string; loadout: SubagentLoadout;
  }
  export function buildPiLaunchPlan(opts: {
    sessionFile: string; loadout: SubagentLoadout; artifactDir: string;
    name: string; surface: string; taskArg: string; effectiveSkills?: string;
    taskDelivery: "direct" | "artifact";
  }): LaunchPlan;
  ```
  Then `index.ts:launchSubagent` shrinks to: resolve agent defs → `resolveLaunchBehavior` → build `loadout` → `taskArg = taskDelivery === "direct" ? fullTask : writeTaskArtifact(...)` → `buildPiLaunchPlan(...)` → `sendLongCommand(...)`. Snapshot-test the exact command string before/after (AGENTS.md rule 2) — the test already exists in spirit (`test/launch.test.ts:138`); extend it to cover the full `piCommand` string for both backends.
- **Benefit:** kills the highest-risk duplication in the codebase (shell quoting is load-bearing); future env/command changes happen once; resume (T3) falls out for free.

## T3. Unify the resume assembler with launch (the other half of T2)

- **Current location:** resume path inside `subagent_message` execute, `index.ts:2240–2330` (parts `~2245–2260`, resume-msg file `2262–2272`, `resumeEnvParts` `2278–2300`, `resumeCdPrefix`/`command` `2305–2307`, `sendLongCommand` `2308–2322`).
- **Problem:** resume rebuilds everything T2 rebuilds: `["pi","--session",…] + -e subagent-done.ts` (duplicates `buildPiParts`), env replay (duplicates `buildEnvPrefix` with subtly different key order — launch puts `PI_SUBAGENT_AGENT` before `PI_SUBAGENT_NAME`, resume puts `NAME` without `AGENT` adjacency; both happen to work but snapshot tests can't catch drift because there are two builders), scrub prefix hardcoded again (`index.ts:2307`), resume-msg file inline (duplicates `writeResumeMessageFile`).
- **Proposed shape:** one new function in `launch.ts`, reusing the T2 plan:
  ```ts
  // launch.ts
  export function buildPiResumePlan(opts: {
    sessionPath: string; loadout: SubagentLoadout; artifactDir: string;
    name: string; surface: string; id: string; activityFile: string;
    message?: string; resumeCwd: string | null;
  }): { command: string; scriptFile: string; resumeMsgFile?: string };
  // internally: applySandboxToParts + buildEnvPrefix({
  //   agentDir: loadout.agentDir, spawnable: loadout.spawnable,
  //   agent: loadout.agent, name, sessionFile: sessionPath, childId: id,
  //   activityFile, surface, autoExit: true,
  //   extra: resumeMsgFile ? [`@${resumeMsgFile}`-as-part?] : [] })
  ```
  Note: `buildEnvPrefix` already takes `extra: string[]` — resume's `PI_SUBAGENT_AUTO_EXIT=1`-always can be expressed as `autoExit: true`. The `subagent_message` handler then becomes ~30 lines: guards → `readSubagentLoadout` → `buildPiResumePlan` → `sendLongCommand` → register + watch.
- **Benefit:** launch and resume *cannot* drift (same sandbox replay, same quoting, same key order); the "resume refuses without loadout" safety invariant stays in one place; the resume path becomes unit-testable without kitty (pure string in, snapshot out).

## T4. Extract result extraction (triplicated fallback strings)

- **Current location:** `watchSubagent` pi branch (`index.ts:1521–1560`), claude branch (`index.ts:1463–1520`), resume-watcher `.then` (`index.ts:2360–2385`). The same 4-way fallback (`findLastAssistantMessage ?? errorMessage ?? exit-code ?? "…without output"`) appears 3× with slightly different wording ("Sub-agent exited…" vs "Resumed session exited…"), and claude cleanup (`unlinkSync(sentinel)` × 2 + `.transcript`) appears in both success (`1505–1509`) and error (`1571–1578`) paths (the N8 comment admits this).
- **Problem:** wording drift between launch-results and resume-results; cleanup duplication that has already needed a dedicated comment to keep in sync.
- **Proposed shape:** new `results.ts` (~80 lines, pure + tiny IO):
  ```ts
  // results.ts
  export function summaryFallback(opts: { entriesSummary: string | null; errorMessage?: string; exitCode: number; label: string }): string;
  export function extractPiSummary(sessionFile: string, afterLine: number, outcome: { errorMessage?: string; exitCode: number }): string;
  export function extractClaudeSummary(opts: { sentinelFile?: string; screenText?: string; exitCode: number }): string;
  export function cleanupClaudeSentinelFiles(sentinelFile?: string): void; // the N8 unlink ×2, called from all paths
  ```
  `watchSubagent` and the resume `.then` both call `extractPiSummary`; both claude paths call `extractClaudeSummary` + `cleanupClaudeSentinelFiles` in a `finally`.
- **Benefit:** one wording table; one cleanup site (fixes the "add a third unlink site and forget one" hazard); result logic becomes unit-testable without spawning anything (`test/bugfixes.test.ts` already tests adjacent policy — this gives it a home).

## T5. Move the three tool handlers + `/subagent` command out of `index.ts`

- **Current location:** `subagent` execute `index.ts:1696–1980` (~280 lines: self-spawn guard, allowlist gate, kitty/session-file prerequisites, name reservation, launch, registry write, watcher fan-out with kept-tab re-registration + notify), `subagents_list` execute `1989–2044`, `subagent_message` execute `2044–2400` (~350 lines: steer-vs-resume dispatch + full resume assembler + resume watcher), `/subagent` command `2403–2432`.
- **Problem:** `index.ts` is a tool-handler file wearing wiring clothes. The handlers mix pure policy (self-spawn check, allowlist gating, ambiguity-vs-fallthrough in steer→resume dispatch) with effects (kitty, registry, watchers), so none of the policy is unit-testable except through the `__test__` keyhole, and the file can't be read top-down.
- **Proposed shape:** `handlers/` with dependency-injected effects:
  ```ts
  // handlers/spawn.ts
  export function validateSpawnParams(params, ctx: { currentAgent?: string; permitted: Set<string>; allowlisted: boolean }): { ok: true } | { ok: false; text: string; details: object };
  export async function executeSpawn(deps: SpawnDeps, params, ctx): Promise<ToolResult>;
  export interface SpawnDeps {
    launch: typeof launchSubagent; store: SubagentStore; registry: RegistryIO;
    notify: Pick<typeof notifications, "notifyResult" | "notifyError">;
    widgets: { startWidgetRefresh(): void; startStatusRefresh(pi): void; updateWidget(): void };
  }
  // handlers/message.ts — same pattern: decideSteerResume() pure, executeMessage() effectful
  // handlers/list.ts — trivial, moves as-is
  ```
  `index.ts` keeps only `pi.registerTool({ name: "subagent", execute: (a,b,c,d,ctx) => executeSpawn(deps, b, ctx), renderCall, renderResult })`. Pure validators (`validateSpawnParams`, `decideSteerResume`, the "No running subagent → fall through, ambiguity → error" rule at `index.ts:2130–2145`) get direct unit tests instead of `__test__` indirection.
- **Benefit:** `index.ts` −700 lines; policy testable without kitty/session fakes; adding a 4th tool (e.g. `subagent_cancel`) is a new file, not a new 200-line block.

## T6. Stop inverting notification strings in the renderers

- **Current location:** `subagent_result` renderer `index.ts:2440–2530`, esp. `2503–2514`: strips `"\n\nFollow up with subagent_message…"` and three `Sub-agent "…" completed/failed…` prefixes via chained `.replace()` + a dynamically-built `RegExp` with manual `escapeRegExp`-style escaping — duplicating `escapeRegExp` (`agents.ts:144`) and mirroring `resolveResultPresentation` (`notifications.ts:20–45`) by hand.
- **Problem:** renderer and notifier are coupled by string surgery: any wording change in `notifications.ts` silently breaks the renderer's stripping (shows raw prefixes or eats summary text). The renderer already receives structured `details` (`name, agent, model, stats, exitCode, errorMessage, sessionFile`) — it doesn't need to parse the human string at all.
- **Proposed shape:** render from `details` + a shared summary helper:
  ```ts
  // notifications.ts
  export function buildResultContent(r: SubagentResultLike): { body: string; followUp: string };
  // renderers.ts — renderer uses details.summary ?? details.body, never touches content
  ```
  Short-term (no protocol change): change the renderer to prefer `details.summary` if present (add `summary` to the `notifyResult` details payload — one line in `notifications.ts:notifyResult`), falling back to the current stripping only for old persisted messages. Long-term: store `summary` + `followUp` as separate detail fields so the renderer never parses prose.
- **Benefit:** removes the only dynamic-`RegExp` in render code; notification wording becomes freely editable; collapsed/expanded views share one truncation helper instead of inline `slice(0, width-6)` × 6.

## T7. Split the three overloaded modules along existing seams

- **Current locations:**
  - `status.ts` (564 lines): config parsing (`parseStatusConfig/parseTabsConfig/parseExtensionConfig/load*`, ~100–250) + state machine (`createStatusState/observeStatus/forceStatusAfterInterrupt/classify*/advanceStatusState`, ~280–430) + line formatting (`formatStatusLine/formatTransitionLine/capStatusLines/formatStatusAggregate`, ~430–564) + a re-export alias `formatElapsedDuration` that just forwards to `format.ts`.
  - `activity.ts` (511 lines): file IO (`getSubagentActivityFile/read/write`, ~200–280) + validation table (`validateActivity` + 7 `validate*` helpers, ~80–200) + recorder closure (`createSubagentActivityRecorder` + `markActive/refreshActiveScope/clearActiveState`, ~280–511).
  - `kitty.ts` (475 lines): availability (`hasCommand/isKittyAvailable/kittySetupHint`, ~30–90) + transport (`kittenSync/kittenAsync/matchFor/shellEscape`, ~90–160) + surface IO (`createSurface/sendCommand/sendLongCommand/readScreen*/closeSurface`, ~160–340) + completion protocol (`interpretExitSidecar/takeCompletionSidecar/__pollForExitTest__`, ~350–410) + `pollForExit` (~415–475).
- **Problem:** each file has 2–3 independent change axes (e.g. touching status formatting risks the config schema; touching kitty transport risks the poll protocol). Imports are already acyclic, so the split is mechanical. Two concrete smells: `status.ts:formatElapsedDuration` is a pure alias of `format.ts:formatElapsedDurationCanonical` (same wrapper disease as T1, one more instance); `activity.ts` validation helpers (`requireObject`, `validateFiniteNumber`, …) duplicate the shape of `status.ts` config validators (`requireObject`, `requireBoolean`, `requirePositiveInt`, `rejectUnsupportedKeys`) — two hand-rolled schema dialects.
- **Proposed shape:**
  ```
  status/config-schema.ts  (parseStatusConfig/parseTabsConfig/parseExtensionConfig + validators)
  status/state.ts          (create/observe/force/classify/advance + SNAPSHOT_STALLED_AFTER_MS)
  status/format-lines.ts   (formatStatusLine/formatTransitionLine/cap/formatAggregate)
  activity/validate.ts     (validateActivity + KNOWN_* sets)
  activity/recorder.ts     (createSubagentActivityRecorder + scope helpers)
  activity/io.ts           (getFile/read/write — atomic write lives here, see T8)
  kitty/terminal.ts        (availability + transport + surface IO + shellEscape + matchFor)
  kitty/completion.ts      (interpretExitSidecar/takeCompletionSidecar + PollResult)
  ```
  Keep the current import paths working via 3-line barrel re-exports (same pattern as `session.ts:41` which already proves this works). Phase 2 (optional): replace both hand-rolled validator sets with one tiny `schema.ts` (`reqObject/reqBool/reqPositiveInt/rejectKeys`) — the "new config key" recipe in AGENTS.md then touches 2 files instead of 4.
- **Benefit:** each future change (new status kind, new activity event, new terminal backend) touches one small file; barrels keep `test/*` imports stable; validator unification removes a duplicated mini-framework.

## T8. Centralize atomic sidecar IO (4 copies of tmp+rename today)

- **Current locations:** `kitty.ts:takeCompletionSidecar` (rename-before-read + corrupt-consumes-silently), `index.ts:claimAskFile` (`1375–1386`, rename-before-read), `subagent-done.ts:writeAskSignalAtomic` (tmp+rename write), `session/registry.ts:registerName` (tmp+rename write), `activity.ts:writeSubagentActivityFile` (tmp+rename write). Five implementations of "atomic file handoff", three with subtly different tmp-name schemes and three with different corrupt-file policies.
- **Problem:** this is the compat-critical protocol (AGENTS.md rule 3: `.exit` wins over `.done`, delete-on-read, fire-once, rename-before-read, torn-lines-skipped). Spread across 4 files, the next sidecar (e.g. a `.progress` file) will invent a 6th variant. The corrupt-`.exit` policy ("consume, don't retry") lives only in a comment (N5) inside `kitty.ts`.
- **Proposed shape:** `session/sidecars.ts`:
  ```ts
  export function atomicWriteJson(path: string, data: unknown): void;          // tmp+rename, pid+rand suffix
  export function claimFile(path: string): string | null;                      // rename to .consuming-*, null on ENOENT/race
  export function readJsonClaim<T>(claimPath: string, opts?: { onCorrupt: "drop" | "restore" }): T | null;
  export function takeSidecar(sessionFile: string, ext: ".ask" | ".done" | ".exit"): unknown | null;
  ```
  Migrate in order: `writeAskSignalAtomic` → `atomicWriteJson` (child side, keep the export as a thin alias for tests), `claimAskFile` → `claimFile`, `takeCompletionSidecar` → `takeSidecar` × 2 (preserving `.exit`-wins + corrupt-consumes), `registerName` + `writeSubagentActivityFile` → `atomicWriteJson`. Each migration is a 5-line diff with existing tests (`test/bugfixes.test.ts`, `test/session-status-split.test.ts`) guarding behavior.
- **Benefit:** rule 3 becomes one file to audit; new signals reuse tested primitives; tmp-name/cleanup policy stops drifting.

---

# Proposed abstractions / modules

These are the new homes the T-items move code into. None adds a framework — each is a named place for code that already exists.

## P1. `lifecycle.ts` — run/kept/watch orchestration (from `index.ts`)

Owns everything that mutates `SubagentStore` + starts/stops watchers: `launchSubagent` orchestration (post-T2 plan execution), `watchSubagent`, `monitorKeptTab`/`trackKeptTab`/`findKeptTab`, `recoverPendingQuestions` + kept-tab reattach loop (currently inline in `session_start`, `index.ts:1600–1648`), and the `session_shutdown` scoped teardown (`index.ts:1651–1695`, M1). Proposed surface:

```ts
export interface LifecycleDeps { store: SubagentStore; kitty: KittyIO; registry: RegistryIO; notify: Notifier; }
export async function launchAndWatch(deps, plan: LaunchPlan, pi): Promise<RunningSubagent>;
export function teardownSession(deps, artifactDir: string | null): void;  // the M1 matchesDir loop, testable without pi
export function recoverSession(deps, artifactDir: string, pi): void;      // ask-recovery + kept reattach
```

Why: today lifecycle state transitions are scattered across 6 functions in `index.ts` plus `store.ts` methods; a single owner makes "who can delete a run / abort a monitor" answerable. Testability: `teardownSession` with a fake store is a pure unit test (today it needs a full `session_shutdown` event).

## P2. `runtime.ts` — process-global keys + interval ownership (from `index.ts:137–155,660–674`)

Centralizes the four `Symbol.for` keys (`widget-interval`, `status-interval`, `poll-abort-controller`, `running-children-count`, `__pi_interactive_subagents`) and the `/reload` rotation logic currently in a bare block at import time. Proposed surface:

```ts
export const RuntimeKeys = { widgetInterval: Symbol.for("…"), … } as const;
export function rotateForFreshImport(): AbortSignal;   // the clearInterval+abort+new-controller block
export function setWidgetInterval(h): void; clearWidgetInterval(): void;  // null-guarded, single site
export function runningChildrenCount(): number;         // replaces the inline closure at index.ts:663
export function publishToolExtension(name, path): void; // the __pi_interactive_subagents block in agents.ts:110-118
```

Why: AGENTS.md rule 4 ("Symbol.for globals survive /reload by design — do not clean into module locals") is currently enforced by comments alone; a module whose *job* is owning them makes accidental cleanup a type error. Also removes the `RUNNING_CHILDREN_COUNT_KEY` writer from `index.ts` while the reader lives in `subagent-done-pure.ts:15` — writer and reader should import the same key.

## P3. `renderers.ts` — message presentation (from `index.ts:2440–2629`)

Owns the three `registerMessageRenderer` callbacks (`subagent_result`, `subagent_status`, `subagent_question`) plus the `renderCall`/`renderResult` closures for the three tools. Depends only on `notifications.ts` (content), `format.ts` (numbers), `widget.ts` (colors/borders) — never on store/kitty. This completes the "notifications owns content, renderers own presentation" split AGENTS.md already gestures at ("New notification shape → notifications.ts helper + renderer in index.ts" becomes "…+ renderer in renderers.ts").

## P4. `command/` or `launch/plan.ts` — one command-assembly pipeline (from T2+T3)

`launch.ts` (227 lines) is cohesive today but will double if T2/T3 land inline. Split as: `launch/env.ts` (`buildEnvPrefix`, `SCRUB_PREFIX`), `launch/command.ts` (`buildPiParts`, `buildPiLaunchPlan`, `buildPiResumePlan`, `buildClaudeCommand` re-exported from `cli/claude.ts` — no move, just re-export), `launch/artifacts.ts` (`writeTaskArtifact`, `writeResumeMessageFile`, `scriptPreambleFor`, `scriptPathFor`), keeping `launch.ts` as the barrel. Rule: any new CLI backend (e.g. `cli/codex.ts`) implements `buildXCommand(opts): { command }` and plugs into the plan — never touches `index.ts`.

## P5. `config/schema.ts` — one validator dialect (from T7)

Today `status.ts:80–130` (config validators) and `activity.ts:60–110` (activity validators) are parallel hand-rolled dialects, and `agents.ts:144–175` (frontmatter `getFrontmatterValue` + `parse*` family) is a third. A 40-line shared `schema.ts` (`reqObject/reqBool/reqPositiveInt/rejectKeys/clampInt`) serves all three; frontmatter parsing additionally wants a real line-map parser (see S7). This is the only P-item that's optional — do it when the next config/activity/frontmatter key is added, not before.

## What NOT to abstract

- **No `utils.ts`.** `names.ts` (43 lines: slug chain) and `paths.ts` (21 lines) are the right size; merging them "for convenience" recreates the grab-bag. The timestamp-tag helper (S3) goes in `format.ts` (it's a presentation concern), not a new utils file.
- **No base-class for tools.** The three tools share only the `sendMessage` envelope (already centralized in `notifications.ts`) — a shared base would couple their validation lifecycles for no gain.
- **No ORM for the registry.** `session/registry.ts` (87 lines, atomic tmp+rename, `{}`-on-corrupt) is a compat boundary; wrapping it hides the exact JSON shape tests pin down.
- **Keep `launch-types.ts` deleted, not expanded** (see S6) — the cycle it guards against doesn't exist.

---

# Small cleanups

- **S1. Dead triple cache in `index.ts:469–477`.** `extensionConfig`/`statusConfig`/`tabsConfig` are written by `refreshConfigCache()` but never read — every call site uses `getExtensionConfig()` fresh (R10). Delete the three `let`s + `safeConfigInit` + `refreshConfigCache`, call `invalidateExtensionConfigCache()` in `session_start`. Keeps the "refresh on session_start" behavior (`config.ts:52`) with zero drift surface. (The M5 loud-failure path then lives in exactly one place: `config.ts:getExtensionConfig`.)
- **S2. Duplicated color constants.** Delete `index.ts:353–357` (`ICON_GREEN/YELLOW/RED/DIM`) and `index.ts:677–678` (`ACCENT`/`RST`); import from `widget.ts:10–16`. Today a theme tweak needs two edits that no test pins together.
- **S3. Timestamp-tag helper.** The `toISOString().replace(/[:.]/g,"-").slice(0,19)` pattern appears 5× (`launch.ts:102,180,190`, `index.ts:1254,2264`) plus a 23-char variant (`index.ts:1044`). Add `timestampTag(now?, len?: 19 | 23)` to `format.ts` (next to the other clocks) and call it everywhere. Trivial, kills a real divergence (19 vs 23 already differs by accident).
- **S4. `slugifyName(x) || "resume"` repeated 4×** (`index.ts:2268,2313`, `launch.ts` equivalents, `names.ts:resumeScriptName` already defaults correctly). Route all resume-script naming through `names.ts:resumeScriptName` (which already handles the empty-slug case) instead of inline `|| "resume"`.
- **S5. `maybeCloseSurface` fallback lies.** `index.ts:422–426`: `keepSurface ?? shouldKeepSurface()` silently re-reads global config when the caller forgot the per-run decision — masking exactly the keep/exit bugs `keep.ts` was extracted to prevent. Make `keepSurface` required; fix the 2 legacy call sites. Same for `keptTabAlive` (`index.ts:585–593`) — it's `windowExistsOrNull(s) !== false` with a try/catch; inline it at the one call site or move it into `store.ts:findKept`'s `exists` default so the N3 policy has one home.
- **S6. Delete `launch-types.ts` (9 lines).** It exists to let `launch.ts:15` import `getToolExtensionPath` "without a cycle" — but `agents.ts` imports only `paths.ts` + `names.ts`, so no cycle exists (`launch.ts → agents.ts → {paths,names}` is acyclic). Import from `agents.ts` directly; delete the shim and the `SubagentLoadoutShim = unknown` alias (an `unknown` alias adds confusion, not safety).
- **S7. Frontmatter parser is regex-per-key.** `agents.ts:148–151` compiles a new `RegExp` per key per file (`getFrontmatterValue` called ~12× per `parseAgentDefinition`, `agents.ts:190–215`). Parse once into a `Map` (`parseFrontmatterBlock(block): Map<string,string>`) and read keys from the map. Fixes the `---`-in-body edge class more robustly than the current fence regex, and makes the next frontmatter field O(1) to add. Keep `getFrontmatterValue` as a thin wrapper for test compat.
- **S8. Collapse the session-mode trilogy.** `resolveEffectiveSessionMode` (`agents.ts:250–254`, ignores its `_params`), `resolveLaunchBehavior` (`agents.ts:256–276`), `resolveEffectiveInteractive` (`agents.ts:283–291`) are three functions where one decision table belongs. Merge into `resolveLaunchPolicy(agentDefs): { sessionMode; seededSessionMode; inheritsContext; taskDelivery; interactive }` — a single exhaustively-tested table replacing the current `sessionMode ?? "standalone"` + `interactive ?? !autoExit` defaults scattered across two functions. Call sites in `index.ts:1080,1107,1114` become one call.
- **S9. Kill the render-time `new RegExp` (see T6).** `index.ts:2510–2513` builds a regex from the agent name with an inline escape (`name.replace(/[.*+?^${}()|[\]\\]/g, …)`) instead of using `escapeRegExp` (`agents.ts:144`). Short-term: import `escapeRegExp`. Long-term: T6 (don't parse prose at all).
- **S10. Unused/vestigial exports.** `format.ts:formatDuration` (55–66) has exactly one caller — its own test (`test/format.test.ts:31–33`) — no production caller; either adopt it at the 3 clock call sites or delete it (a unused "unified entry point" is worse than three named functions). `agents.ts:escapeRegExp` is exported but only used internally (keep exported only if S9 adopts it). `kitty.ts:createSurfaceSplit`, `isSurfaceAvailable`, `muxSetupHint`, `isMuxAvailable`, `index.ts:kittyUnavailableResult/muxUnavailableResult` pair — pick one name per concept (`Surface` per the `kitty.ts` header) and delete the aliases; each alias is a future import-site coin flip. `session/legacy-branch.ts` (71 lines, zero production callers, own duplicate `readEntries`) — delete the file + `session.ts:37–41` re-exports + `test/session-status-split.test.ts:85–94` quarantine test, per its own `@deprecated do not use` header.
- **S11. `resolve()` path-compare without a helper.** `index.ts:2200` (`resolve(r.sessionFile) === resolve(sessionPath)`) duplicates `store.ts:findRunningBySessionFile` (`store.ts:44–55`, same `resolve`-compare with try/catch). Export `sameSessionFile(a,b)` from `session/io.ts` (or `store.ts`) and use in both — the try/catch matters (unresolvable paths) and only one copy has it.
- **S12. `SUBAGENT_CONTROL_TOOLS_CANONICAL` voided.** `index.ts:759`: `void SUBAGENT_CONTROL_TOOLS_CANONICAL` — an import kept alive to avoid an unused warning. Either use it (pass `spawningTools` explicitly at `index.ts:767` instead of reaching for module-local `SPAWNING_TOOLS`) or drop the import. Same for `DEFAULT_SUBAGENT_TOOLS_CANONICAL` → local `DEFAULT_SUBAGENT_TOOLS` alias (`index.ts:758`): one name, not two.
- **S13. `getShellReadyDelayMs` env-parse pattern.** `index.ts:371–377` (`Number.parseInt` + `Number.isFinite` + `>= 0` + default 500) will be copy-pasted for the next tunable delay. Extract `getEnvIntMs(name, def, {min})` into `config.ts` (it's config, not kitty policy) — 6 lines that prevent 3 future divergences.

---

# Extensibility notes (how future features fit after this refactor)

- **New CLI backend (e.g. `cli/codex.ts`).** Today: touch `launchSubagent`'s if/else chain (`index.ts:1118–1165`), `watchSubagent`'s extraction branch (`1463–1520`), `status-bridge.ts` (`cli === "claude"` early-return), `widget.ts` right-label (`claude` special-case), `copyClaudeSession` wiring. After P4: implement `cli/codex.ts:buildCodexCommand()` + `extractCodexSummary()` in `results.ts` + a `source: "codex"` arm in `status.ts/state.ts`; the plan pipeline (`buildXLaunchPlan`) is backend-agnostic. No `index.ts` change. Precondition: generalize the `running.cli === "claude"` checks into a `Backend = "pi" | "claude" | …` discriminated union with per-backend `{ buildCommand, extractResult, observesActivity: boolean }` — the `status-bridge.ts:observeRunningSubagent` early-return and `widget.ts:formatWidgetRightLabel` `cli` param are the two hardcoded spots to absorb.
- **New config key.** Today (per AGENTS.md): `status.ts` parse/validate + `config.ts` + example + docs = 4 files. After T7/P5: add the field to `status/config-schema.ts` (validator from `config/schema.ts`) + `config.json.example`; `config.ts` needs no change (it just caches `loadExtensionConfig`). Validation errors stay loud (rule 5) because there's one throw site.
- **New notification shape.** Unchanged path, shorter: `notifications.ts` helper (envelope stays there) + `renderers.ts` renderer (not `index.ts`). The T6 `summary`-in-details convention means new shapes render from structured data from day one.
- **New agent frontmatter field.** After S7: add the key read in `agents.ts:parseAgentDefinition` (now a map lookup), thread through `SubagentLoadout` (`session/loadout.ts`) only if resume must replay it (the T3 plan makes "must resume replay this?" the explicit question — today it's answered by accident per-field), document in `README.md` + `docs/AGENT-OPTIONS.md`. The S8 policy table makes `interactive`/`sessionMode`-like derived fields a one-row addition.
- **New sidecar signal (e.g. `.progress`).** After T8: `takeSidecar(sessionFile, ".progress")` in the watcher `onTick` + `atomicWriteJson` in the child. Inherits rename-before-read, fire-once, corrupt-policy for free. Do not add a 6th ad-hoc tmp+rename.
- **Nested spawning depth limits.** The `PI_SUBAGENT_ALLOWED` gate (`agents.ts:getSubagentAllowlist`, enforced in `subagent` execute `index.ts:1730–1770`) is the right seam; a depth counter rides the same env channel (`PI_SUBAGENT_DEPTH`) and is checked in `validateSpawnParams` (T5) — pure, testable, no watcher changes.
- **Multi-session / `/reload` hardening.** After P2: all `/reload`-sensitive state is enumerated in `runtime.ts`; the M1 scoped-teardown (`lifecycle.ts:teardownSession`) is the only shutdown path. New per-session state must register its interval/abort there or it leaks across reload — reviewable in one file.

---

# Suggested order of work

Phases are ordered by **risk-reduction per diff-size**; each ends green (`npm test`, ~227 tests) with zero behavior change unless noted. Snapshot the exact kitty command strings *before* phase 2 (byte-identical gate for T2/T3 per rule 2).

1. **Phase 0 — Safety net (1 PR, no source changes).** Add exact-command snapshot tests: full `piCommand` string for a pi launch (model+identity+tools+skills+spawning), a claude launch, and a resume command, pinned against current output. Extend `test/launch.test.ts` (exists, 138 lines) — today it covers builders in isolation, not the assembled command. Without this, phases 2–3 are unsafe.
2. **Phase 1 — Delete wrappers + dead code (T1, S1, S2, S6, S12; ~1–2 PRs).** Mechanical: re-point call sites at `*Canonical` imports, delete wrappers, point `__test__` at canonicals, delete triple cache/safeConfigInit, dup constants, `launch-types.ts`. Verify: `npm test` + grep `function <name>` in `index.ts` returns nothing that exists in a home module. Expected: `index.ts` −400 lines, zero behavior change. Low risk, high morale.
3. **Phase 2 — Unify command assembly (T2+T3, S3, S4; 1 PR).** Introduce `buildPiLaunchPlan`/`buildPiResumePlan` in `launch.ts`, migrate `launchSubagent` + resume path call-site by call-site, proving byte-identical output against Phase-0 snapshots. Migrate timestamp/slug one-liners (S3/S4) inside the same diff since they touch the same lines. Expected: −120 lines net, −2 builders. Medium risk (shell quoting) — fully covered by Phase-0 snapshots.
4. **Phase 3 — Extract results + renderers (T4, T6, S9; 1 PR).** New `results.ts` (dedupe extraction/cleanup), new `renderers.ts` (move 3 renderers + 6 renderCall/renderResult closures), add `summary` to `notifyResult` details with stripping-fallback for old messages. Expected: `index.ts` −350 lines. Low-medium risk; renderer output pinned by existing `test/test.ts` renderer assertions (verify they exist; add 2–3 if not).
5. **Phase 4 — Extract handlers + lifecycle (T5, P1, P2, S5, S11; 1–2 PRs).** Move `subagent`/`subagent_message`/`subagents_list` executes to `handlers/`, `session_start` recovery + `session_shutdown` teardown + `monitorKeptTab`/`watchSubagent` orchestration to `lifecycle.ts`, globals to `runtime.ts`. Make `keepSurface` required (S5), share `sameSessionFile` (S11). Expected: `index.ts` −700 lines, landing at ~350 lines of pure registration. Medium risk (watcher wiring) — integration suite (`test/integration/`, kitty socket) gates this phase.
6. **Phase 5 — Split overloaded modules + sidecars (T7, T8, S7, S8, S10, S13; as-needed PRs).** Barrel-preserving splits of `status.ts`/`activity.ts`/`kitty.ts`, `session/sidecars.ts` migration, frontmatter map parser, session-mode table merge, alias/dead-code deletion (`formatDuration` decision, `mux*` aliases, `legacy-branch.ts`). Do these lazily — each is independently shippable and none blocks phases 1–4. The validator unification (P5) waits for the next schema change.
7. **Phase 6 — Docs sync.** Update `AGENTS.md` canonical-home table (add `handlers/`, `lifecycle.ts`, `runtime.ts`, `renderers.ts`, `results.ts`, `session/sidecars.ts`; record `launch-types.ts` deletion + `legacy-branch.ts` deletion), `docs/HOW-IT-WORKS.md` flows, and the "Common tasks" recipes (new-backend, new-config-key paths change after P4/P5). Small PR, done last so it describes reality.

**Do-not-do list (guardrails for the above):** no behavior change in phases 1–3 (byte-identical commands); no `session.ts` barrel breakage (keep re-exports until tests migrate); no `__test__` key removal (only re-pointing — `test/test.ts` has ~20 `__test__` call sites); no registry/`.exit`/`.done` format change (compat boundary, rule 3); no polling-loop/watcher-semantics change (fire-and-forget stays, per AGENTS.md header).
