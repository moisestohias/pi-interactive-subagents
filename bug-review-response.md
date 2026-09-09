# Bug Review Response — triage of `bug-review-findings.md`

**Re-revision:** `27995a8` + dirty worktree (same as reviewer). **Responder:** refactor worker (owns `refactor-suggestions-v2.md` + current worktree). **Method:** re-read the full bug doc, re-checked every cited `file:line` against current worktree, re-ran `npm test` (211 total: 207 pass / 4 fail — same 4 as reviewer).

---

## 1. Validated Criticals (all four confirm — fix before anything else)

### C1 — CONFIRMED: bundled `agents/*.md` deleted, spawns + 4 tests broken
- **Evidence:** `ls agents/` → `No such file or directory`; `git status --short` shows staged `D agents/worker.md`, `D agents/scout.md`, `D agents/researcher.md`. `pi-extension/subagents/agents.ts:140-149` (`getBundledAgentsDir` → `join(getSubagentsDir(), "../../agents")`) now resolves to a missing dir, so `loadAgentDefaults("worker")` returns `null` and `discoverAgentDefinitions()` loses the package tier. `npm test` fails at `test/test.ts:1265,1277,1291` exactly as cited.
- **Correction/nuance (C1-note):** the 4th failure (`test/test.ts:1341`, `web_search` → `web-search/index.ts`) is **not** caused by the deletion. `agents.ts:121-129` (`getToolExtensionPath`) requires `existsSync` under `PI_CODING_AGENT_DIR/extensions/`, which the isolated test env never populates — it is a **pre-existing environment-dependent test**, exposed now but not a knock-on. Fix it by stubbing the ext dir in the test (or `EXTRA_TOOL_EXTENSIONS` injection), not by restoring agents.
- **Action:** restore the three files (`git restore --staged agents/ && git restore agents/`) OR finish the move deliberately (new canonical dir + `getBundledAgentsDir` update + test updates). Do not leave code/tests/disk disagreeing.

### C2 — CONFIRMED: orphaned kitty tab when post-`createSurface` work throws
- **Evidence:** `pi-extension/subagents/index.ts:1019` (`createSurface`) precedes fallible `1027` (`seedSubagentSessionFile`), `~1090-1250` (`mkdirSync`/`writeFileSync` task artifact + sysprompt, `sendLongCommand`); the `subagent`-tool `try/finally` at `~1712-1725` only releases the name reservation. Resume duplicates the shape (`2122` create → `2188` send). No `closeSurface` on these paths — verified by grep, no `closeSurface` between 1019-1260 except inside `watchSubagent` (which never starts on launch throw).
- **Action:** wrap post-create body in try/catch → best-effort `closeSurface` (guarded by `isKittyAvailable`) → rethrow. Same for resume. Small, safe, high value.

### C3 — CONFIRMED: non-atomic `.ask` write + delete-on-malformed consume can lose questions
- **Evidence:** write `pi-extension/subagents/subagent-done.ts:352` (`writeFileSync(`${sessionFile}.ask`, …)` — truncate+write, observable mid-flush); consume `pi-extension/subagents/index.ts:1337-1365` (`readFileSync`+`JSON.parse` in try, `unlinkSync` in malformed branch). Poll ticks every 1s (`1396` `pollForExit.onTick`) + 2s kept-tab tick (`583`) + `session_start` recovery (`1332`) all race the same file. Probability low, impact total (child parks on `awaitingAnswer` forever).
- **Action:** child writes tmp+`renameSync` (pattern already used in `activity.ts:writeSubagentActivityFile`, `session/registry.ts:registerName`); consumer claims via `renameSync(.ask → .ask.consuming-<pid>-<rand>)`, `ENOENT` = lost race → return. Fixes C3+M4 together.

### C4 — CONFIRMED: resume continuation crashes on one torn line, discarding a good result
- **Evidence:** `index.ts:2235` (`getNewEntries(sessionPath, entryCountBefore)`) inside resume `.then()`; `session/io.ts:35` bare per-line `JSON.parse`, no guard. One malformed line routes to `.catch()` → `Resume error: …` despite `watchSubagent` already succeeding. Launch path (`1447`) shares the strict reader (its outer catch converts to `Subagent error:` the same way).
- **Action:** same fix as M3 (tolerant reader) + defensive try/catch around 2235 falling back to `result.summary`. Both, not either/or.

---

## 2. Majors — validation

| ID | Verdict | Evidence / correction |
|---|---|---|
| **M1** `session_shutdown` aborts process-global poll controller | **CONFIRMED (Critical-adjacent).** `index.ts:1571-1593` (`moduleAbort.abort()` + `runningSubagents.clear()` + `keptTabs.clear()` on *every* shutdown); watchers join it at `577` (`monitorKeptTab`) and `1396` (`watchSubagent`); fresh controller only on next `session_start` (`1522-1524`). Multi-session cross-cancel is real. The `Symbol.for` sharing was intentionally preserved by my refactor (correct for `/reload`, wrong for shutdown) — needs per-session scoping now. | |
| **M2** explicit-name collisions steal handles / steer at random | **CONFIRMED.** `1712-1714` dedups only when `!params.name?.trim()`; `subagent_message` running branch at `~2006-2020` uses `Array.find` (first match); `resolveRunningByName` (`781-789`, via `store.ts`) already returns ambiguity errors but is bypassed there. | |
| **M3** strict JSONL readers throw on first torn line | **CONFIRMED, same root as C4.** `session/io.ts:12` (`readEntries`), `:35` (`getNewEntries`), `:50` (`readEntriesAfter`) all bare `JSON.parse`; `legacy-branch.ts:17` same; `index-cache.ts:38` already guarded (inconsistency proves intent). `summarizeSessionStats` catches → `null` but summary path throws — confirmed inconsistent. | |
| **M4** double-fire under concurrent `.ask` consumers | **CONFIRMED (shape).** `1337-1380` check-then-act (`existsSync`→read→notify→`unlink`) with three concurrent consumers (1s tick, 2s kept tick, `session_start` recovery). Window is small but unguarded. Fixed by the same C3 atomic-claim. | |
| **M5** `lineLimit` unconfigurable + silent total-config fallback | **CONFIRMED.** `status.ts:141-149` (`rejectUnsupportedKeys(status, ["enabled"])` + hard `lineLimit: DEFAULT…`); any `status.lineLimit` key throws; `config.ts:16-27` catch-all → defaults discards the *whole* file (including valid `tabs`). My refactor's `config.ts` kept the catch-all, so this is still live. | |
| **M6** canonical builders dead + drifted | **CONFIRMED (with line update).** Only `copyClaudeSession` imported (`index.ts:70`); `cli/pi.ts:52` (`buildPiLaunchCommand`), `:115` (`buildPiResumeCommand`), `launch.ts:229` (`buildClaudeParts`) unreferenced. Drift confirmed and **worse than cited**: resume hand-rolled `resumeEnvParts` (`~2157-2176`) omits `PI_SUBAGENT_SURFACE` (launch includes it at `~1200`), key order differs, preamble formats differ (ad-hoc 3-liner `1101-1105`/`1246-1256` vs `scriptPreambleFor`). Security-sensitive duplication — finish or delete. | |
| **M7** dead builders drop preamble / plugin dir | **CONFIRMED.** `cli/pi.ts:94-100` (`void preamble`, never returned), `:151` (`void scriptPreambleFor`), `launch.ts:229-234` (`void dir`, `buildClaudeParts` ignores plugin dir vs live `1072-1079` `--plugin-dir`). Wiring them as-is would regress claude sentinel detection to screen-scrape only. | |
| **M8** `shouldAutoExitOnAgentEnd` ignores takeover param | **CONFIRMED, downgrade to Minor.** `subagent-done-pure.ts:25-40` (`_userTookOver` unused; decision purely last-assistant `stopReason !== "aborted"`). Benign today, misleading contract in the session-kill path. Remove param or implement + comment. | |
| **M9** `safe_bash` unenforced + bypassable + frozen cwd | **PARTLY CONFIRMED (a+b yes, c nuanced).** (a) Yes: `agents.ts:59` (`bash` in `BUILTIN_TOOLS` → `getToolExtensionPath` returns `undefined`), baseline grants native `bash`; `safe_bash` loads only if literally listed — claim overstates coverage. (b) Yes: patterns (`tools/safe-bash.ts:12-30`) miss `--`, `/tmp/../`, `$()/`` ``, `env sudo`, `python3 -c`. (c) **Disputed as stated:** `createBashTool(process.cwd())` at load (`tools/safe-bash.ts:42`) captures the *child* process cwd (child `cd`s before pi starts), so it is correct for the spawn lifetime; only wrong if the process chdirs later. Keep as hardening note, not a live bug. | |
| **M10** `on-stop.sh` python3/strictness/schema trust | **CONFIRMED with one nuance.** (a) Yes: 3× `python3 -c`, no `command -v` guard, `set -euo pipefail` — hook fails on minimal images. (b) Yes in effect: `[ "" -eq 1 ]` exits 2 → bare statement under `set -e` aborts before sentinel logic. (c) Plausible fragility (only string-content user msgs counted; array human msgs miscount → early/late sentinel) — accepted on code reading, schema not independently verified. | |

---

## 3. Minors — validation (abbreviated)

- **N1 CONFIRMED (trivial):** `index.ts:237` frozen `SUBAGENT_ALLOWLIST` is now dead weight (live gate uses `getSubagentAllowlistFresh()` at `~1712`/`~2006`); delete it. `extensionConfig/statusConfig/tabsConfig` lets (`~444`) refresh only on `session_start` — document as intended, not a bug.
- **N2 CONFIRMED (latent):** `kitty.ts:30-48` (`hasCommand` caches forever, `sh -c` interpolation; only ever `"kitty"`). Harden + recheck-on-false.
- **N3 CONFIRMED:** `kitty.ts:191-216` any `ls` failure → `false` → `sendCommand` reports death for live tabs. Return `null`/throw distinctly.
- **N4 CONFIRMED (advisory):** `kitty.ts:221-232` TOCTOU + double round-trip; guard is defense-in-depth, not a guarantee — comment already half-says so.
- **N5 CONFIRMED:** `kitty.ts:345-360` corrupt `.exit` JSON skips `rmSync` → hot retry loop every tick. `rm`/rename-before-parse.
- **N6 NO-ACTION (agree with reviewer):** `kitty.ts:390-418` sleep-after-failed-screen-read is negligible latency on an already-degraded path.
- **N7 CONFIRMED:** `index.ts:1419` sync `readScreen(surface, 200)` inside async `watchSubagent` blocks the host; use `readScreenAsync`.
- **N8 CONFIRMED:** `/tmp/pi-claude-${id}-done` (`index.ts:1068`, `cli/claude.ts:29`, 8-hex `id`) predictable + abort-path leak (`watchSubagent` catch never unlinks); `cli/claude.ts:69` `cleanupClaudeSentinel` exists but is never called from `index.ts`. Wire it everywhere + unique dir/`O_EXCL`.
- **N9 CONFIRMED:** `index.ts:583` + `1332` build carriers with `startTime: Date.now()` per tick → kept-tab questions always report `0s`. Thread original `startTime` through `KeptTab`.
- **N10 CONFIRMED (trivial):** `status-bridge.ts` leftover `const { read…: read } = …; void read;` — delete.
- **N11 CONFIRMED (trivial):** `SUBAGENT_CONTROL_TOOLS`/`DEFAULT_SUBAGENT_TOOLS` duplicated (`launch.ts:241-242` vs `index.ts` wrappers) — delete index copies, import canonical.
- **N12 CONFIRMED (latent):** `agents.ts:144` unescaped `key` in `RegExp` (all call sites constant today) — escape anyway.
- **N13 CONFIRMED:** `agents.ts:194` (`/^---\n([\s\S]*?)\n---/`) breaks on CRLF/trailing-space fences/`---` in values → silent wrong-field/`null`. Tolerate `\r?\n`, anchor closing fence at line start.
- **N14 CONFIRMED (trivial):** `format.ts:26-31` unclamped negatives/NaN (`formatElapsed`, `formatElapsedMMSS`; `formatElapsedDuration` already clamps) — clamp all three.
- **N15 CONFIRMED:** `widget.ts:62-72` `titlePart.length` miscounts wide/CJK → use `visibleWidth` (already imported).
- **N16 CONFIRMED (trivial):** `cli/claude.ts:10-14` `process.env.HOME ?? "/tmp"` → `os.homedir()` for consistency.
- **N17 CONFIRMED (hygiene):** `session/registry.ts:36-66` swallow-all on registry I/O hides disk-full/perm loss of resume handles — log once.
- **N18 DOWNGRADE to nit (agree):** `AbortSignal.any` (Node ≥20.3) with no `engines` field — hygiene; repo runs Node 22. Add `"engines": {"node": ">=20.3"}`.
- **N19 NO-ACTION (agree):** `activity.ts:scheduleFlush` 500ms timer — `markDone`/`disable`/`sessionShutdown` clear it; negligible, do not "fix".
- **N20 CONFIRMED (process):** tracked `config.json` (`tabs.keepOpen: true`) vs example (`false`) — fresh clones differ from docs. Either gitignore user-local `config.json` or sync it with the example and document intent.

**No other false positives found.** N6/N19 are explicitly non-issues (reviewer agrees); M8/M9c/N18 are severity corrections, not rejections.

---

## 4. Overlap With Refactor (`refactor-suggestions-v2.md`)

| Bug | Refactor item | Relationship |
|---|---|---|
| C1 deletions | — (assumed agents exist) | **Unrelated / blocks all.** Restore first; nothing else is verifiable while red. C1-note 4th failure is the `getToolExtensionPath` closed-set issue already flagged in **R7**. |
| C2 tab leak | **L2** launch unification + lifecycle | **Would-fix-if-finished.** Builders (`launch.ts`, `cli/pi.ts`) centralize post-create work where one try/catch covers all backends. Currently half-landed, so still live. |
| C3+M4 `.ask` race | **R8/L4** session seams + **L3** store | **Partially prepared, not fixed.** Atomic tmp+rename pattern exists in new `session/registry.ts`, `activity.ts` but was never applied to `.ask`; `SubagentStore` owns identity but not claim. Direct follow-on. |
| C4+M3 strict readers | **R8/Q5/L4** (`readEntriesAfter`, legacy quarantine) | **Prepared, not fixed.** Split created the seam but kept strict `JSON.parse` (my `readEntriesAfter` inherited it). Tolerant parser slots straight in. |
| M1 global abort | **R10/L5** (config/allowlist as params) | **Adjacent, not overlapping.** Refactor intentionally preserved `Symbol.for` sharing for `/reload`; M1 needs the opposite for shutdown (per-session scope). Do not conflate. |
| M2 name collisions | **L3/R6** (`SubagentStore.uniqueName/resolve`) | **Half-fixed.** Store has both primitives; `index.ts` still applies uniqueness only to defaulted names and bypasses `resolveRunningByName` at `~2006`. Policy one-liner + wiring. |
| M5 `lineLimit` + swallow | **R10/L5** (`config.ts`) | **Made slightly worse.** `config.ts` kept the catch-all fallback. Accept+validate `lineLimit`, narrow catch to `ENOENT`. |
| M6+M7 dead builders | **R2/L2 + R11** (unify + CLI seam) | **The refactor IS the bug here** — half-landed canonicals with `void preamble`/`void dir` + drift (`SURFACE` omission, preamble/plugin-dir). Finish-or-delete before any L2 consumer. |
| M8 ignored param | **R1** subagent-done split | **Moved, not fixed.** `subagent-done-pure.ts` extracted the lie verbatim. Signature fix is trivial now. |
| M9 safe_bash | **R7** (closed tool sets) | **Noted, not addressed.** R7 flagged silent drops; M9a/b need explicit `bash→safe_bash` decision + tokenizer hardening. New work. |
| M10 hook script | — (out of scope) | **Unrelated.** No refactor item covers `plugin/hooks`. |
| N1 frozen const | **R10** | **My leftover.** I added `getSubagentAllowlistFresh` but left the frozen const — delete it now. |
| N5 poison sidecar | L2 sidecar note | **Adjacent** to implementer note (sidecar deletion semantics) — rename-before-parse. |
| N7/N8 claude paths | **R11** | **Same seam.** `readScreenAsync`, `cleanupClaudeSentinel` wiring, unique sentinel dir all belong to finishing R11. |
| N9 kept elapsed | **L3** store | **Store gap.** `KeptTab` lacks original `startTime` — add field, thread through `trackKeptTab` + `session_start` rebuild. |
| N10/N11/N14/N15 | **Q/R quick wins** | **Direct leftovers** of Q6/R9/R4/R1 — one-line cleanups each. |
| N12/N13 frontmatter | **R1** agents | Same file, unaddressed — escape key, tolerate CRLF. |
| N20 config.json | **R10** | Same config ownership question — decide gitignored-vs-default. |

**Clean areas (reviewer §8):** agreed — quoting/`matchFor`, KEEP_TAB removal, keep truth table (`keep.ts`), double-open guard, `awaitingAnswer` clear-on-`input`+`agent_start`, registry atomicity, index cache, activity validation, status machine, notification envelope, `/reload` survival all verified sound during the refactor and left intact by it.

---

## 5. Suggested Fix Order (interleaved with refactor sequencing)

Refactor order was `Q1→Q2→Q3→Q4→Q6→L1→L2→L3→R9→L6→L4→L5`. Bug severity demands data-loss/cross-talk first. Interleaved order below keeps each step small and test-pinned; items marked ★ unblock everything after them.

1. ★ **C1 — restore `agents/*.md`** (or finish the move). Unstages the red suite; without it every later verification is suspect. Then fix the C1-note test properly (stub ext dir / inject `EXTRA_TOOL_EXTENSIONS`).
2. ★ **C3+M4 — atomic `.ask`** (child tmp+rename; consumer rename-claim with `ENOENT`-wins). Add a concurrency test (two consumers, one file → exactly one delivery). Fixes the only silent-data-loss path.
3. ★ **M3+C4 — tolerant JSONL reader** (`io.ts: skip blank+malformed, optional `{skipped}` count; use in `readEntries/getNewEntries/readEntriesAfter`; try/catch + `result.summary` fallback at `index.ts:2235`). Add torn-file tests (mid-flush truncation, garbage line).
4. **C2 — tab cleanup on launch/resume failure** (try/catch → `closeSurface` best-effort). Test with injected failing `sendLongCommand`/seed.
5. **M1 — scope shutdown abort per-session** (per-session controllers joined with watcher signal; keep module-global abort for `/reload` import rotation only). Needs a two-session regression test — highest-risk change here, do it while the area is fresh.
6. **M2 — explicit-name policy** (reject duplicates with clear error OR `uniqueRunningName` for all; route `~2006` through `resolveRunningByName`). Decide product behavior first — everything else is mechanical.
7. **M6+M7 — finish-or-delete builders.** Recommended: finish (route launch+resume+claude through `cli/pi.ts`+`cli/claude.ts`, include preamble via `scriptPreambleFor`, thread `pluginDir`, snapshot-test exact commands incl. `PI_SUBAGENT_SURFACE` parity). If schedule forbids, delete the dead files now and re-land later — two truths for sandbox/env must not survive.
8. **M5 — config:** accept+validate `lineLimit` (positive int, default 4), narrow `config.ts` catch to `ENOENT` (surface schema errors). Add `status.lineLimit` + invalid-config tests.
9. **M8+N10+N11+N14+N15 batch** (each <15 min): drop `_userTookOver` param or implement; delete `void`-dance; delete index tool-const copies; clamp formatters; `visibleWidth` in `borderTop`.
10. **N5+N7+N8+N9 claude/kitty batch:** rename-before-parse sidecars; `readScreenAsync` in `watchSubagent`; wire `cleanupClaudeSentinel` on all paths + unique sentinel dir; thread `startTime` into `KeptTab`.
11. **M9 — safe_bash honesty pass:** (i) document whether baseline `bash` is wrapped (today: no) and, if it should be, map `bash→safe_bash` explicitly; (ii) block `--`, `..`-traversal, `$()`/backticks/`env`-prefix in patterns (or shell-tokenize); (iii) per-call cwd. Do not ship as "security" until (i)+(ii) land.
12. **M10 — hook hardening:** `command -v python3` guard with `node -e`/bash fallback, safe-default `user_msg_count`, count array-content human msgs. Test with python3 hidden from `PATH`.
13. **N-hygiene sweep:** N1 (delete frozen const), N2 (shell-free `hasCommand` + recheck), N3/N4 (distinct control-error vs gone), N12/N13 (frontmatter escaping/CRLF), N16 (`os.homedir`), N17 (log registry I/O errors once), N18 (`engines`), N20 (`config.json` gitignore-vs-default decision).

**Explicitly deferred (agree, no action):** N6 (completion-path sleep), N19 (recorder timer).

---

## 6. Fixes applied (post-triage implementation)

Per user direction the staged `agents/*.md` deletions were left alone (C1 not
actioned — owner keeps those files elsewhere; the 4 failing tests are accepted
as environmental). Everything else below is implemented in the worktree;
`npm test` is 223 pass / 4 fail / 227 total (the same 4 pre-existing
agents failures; +55 new passing tests since the review).

- **C2** — `launchSubagent` wraps everything after `createSurface` in
  try/catch → best-effort `closeSurface` (own surfaces only) → rethrow
  (`index.ts`); same for the resume branch.
- **C3+M4** — child writes `.ask` via tmp+`renameSync`
  (`subagent-done.ts:writeAskSignalAtomic`); consumer claims via
  `renameSync(.ask → .ask.consuming-<pid>-<rand>)` before read
  (`index.ts:claimAskFile`/`deliverPendingQuestion`); `ENOENT` = lost race;
  no-target/notify-failure renames the claim back for retry.
- **M3+C4** — `session/io.ts` readers skip blank+malformed lines
  (`parseEntryLine`); `readEntriesAfter` reports `{skipped}`;
  `legacy-branch.ts` matches; resume continuation (`index.ts`) falls back to
  `result.summary` on read errors.
- **M1** — `session_shutdown` no longer aborts the process-global poll
  controller (reserved for `/reload` rotation). `RunningSubagent` carries
  `parentArtifactDir` (set at all 3 creation sites); shutdown aborts/clears
  only that session's watchers + kept tabs (falls back to abort-all when the
  dir is unresolvable).
- **M2** — explicit names go through `uniqueRunningName` too (`X` → `X-2`,
  rename surfaced in ack `details.requestedName/renamed`);
  `subagent_message` running branch routes through `resolveRunningByName`
  (ambiguity errors instead of random steer).
- **M6+M7** — resolved by deletion + one wiring: removed `cli/pi.ts`
  (`buildPiLaunchCommand`/`buildPiResumeCommand`) and `launch.ts`
  `buildClaudeParts` (`void` bugs died with them); wired the live claude path
  through `cli/claude.ts:buildClaudeCommand` (verified byte-identical order);
  `PI_SUBAGENT_SURFACE` omission in resume confirmed consistent (live and
  builder both omit; the var is write-only informational) — left as-is.
- **M5** — `parseStatusConfig` accepts+validates `lineLimit` (positive int,
  default 4); `config.ts` falls back only on missing-file, rethrows
  invalid-JSON/schema (import/`session_start` use loud `safeConfigInit`
  fallback + `console.error` so framework hooks never crash).
- **M8** — contract documented on `shouldAutoExitOnAgentEnd` (param reserved,
  ignored); no behavior change.
- **M9** — `safe_bash` header/docs state best-effort opt-in reality; added
  `--`/`..`/*`env sudo*/substitution patterns; per-call cwd + `ctx`
  pass-through (was dropped).
- **M10** — `on-stop.sh`: `json_field` helper (python3 → node → empty),
  safe `user_msg_count` default + integer sanitization, array-content human
  blocks counted, transcript path always recorded; verified by direct runs
  (string/array fire, tool_result-only doesn't, missing python3 exits 0).
- **N-batch** — N1 frozen const deleted; N2 shell-free probe, positives-only
  cache; N3 `windowExistsOrNull` (control failure ≠ gone), prune/guard paths
  conservative (no prune on unknown, resume refuses on unknown);
  N4 advisory comment; N5 rename-before-parse sidecars; N7 async scrape;
  N8 sentinel cleanup on abort/error; N9 `KeptTab.startTime` threaded;
  N10 dead lines removed; N11 index const copies removed;
  N12 key escaping + `escapeRegExp` export; N13 CRLF/anchored/EOF-tolerant
  fence (verified EOF + CRLF parse); N14 clamped formatters;
  N15 `visibleWidth` fill; N16 `os.homedir()` (+ dead index const removed);
  N17 log-once on registry read/write failures; N18 `engines >=20.3`.
  N6/N19 deferred (no action, agreed). **N20 needs no fix:** `config.json`
  is gitignored (`.gitignore:2`) and untracked — the observed `keepOpen:true`
  is local-only; fresh clones fall back to `config.json.example` (`false`).
- **Tests** — new `test/bugfixes.test.ts` (16 tests: lineLimit, torn-file
  readers, clamped formatters, claude builder, safe_bash patterns, unique
  names, atomic ask single-delivery + corrupt-drop); wired into
  `package.json:test`.
