# Review — bug-findings.md (28 findings + compat risks)

Reviewed against source at `pi-extension/subagents/`. Line numbers ±15.
Method: read `index.ts` (2629 lines, in chunks), `kitty.ts`, `launch.ts`,
`session/registry.ts`, `session/io.ts`, `session/loadout.ts`, `store.ts`,
`names.ts`, `status.ts`, `config.ts`, `agents.ts`, `cli/claude.ts`,
`plugin/hooks/on-stop.sh`, `tools/safe-bash.ts`, `subagent-done.ts`,
`subagent-done-pure.ts`, `session/seed.ts`, `session/index-cache.ts`,
`notifications.ts`. No source edited.

## Verdict

**Strong pass, ship the fixes with amendments: 26.5/28 confirmed, 1 disputed (H2),
0 duplicates, 3 severity downgrades, 1 finding incomplete in a way that matters (C1
misses the Claude preamble).** Evidence quality is high — file:line refs checked out
in every case I sampled (all within tolerance), trigger steps match the code, and the
suggested fixes point at the right homes (consistent with AGENTS.md single-home rule).
The report is honest about what is benign today (M10, L9, L10) and correctly leaves the
4 pre-existing `test/test.ts` discovery failures alone.

Biggest gaps in the report itself: (a) C1's fix location is incomplete — the Claude
launch path builds its preamble **inline** (`index.ts` ~1136-1140) and bypasses
`scriptPreambleFor`, so sanitizing that function alone leaves an RCE vector open;
(b) H2's repro is wrong for in-process concurrency (Node single thread + fully-sync
`registerName` = no interleave); (c) M10/M11 are filed as Medium but are Low by the
report's own impact statements ("benign", "responsiveness only").

---

## Confirmed (with brief why)

### C1 — CONFIRMED, Critical stands, but fix scope is incomplete (see Missing #1)
- `launch.ts` `scriptPreambleFor` interpolates `meta.name` / `meta.sessionFile` /
  `meta.surface` / `meta.resumeMsgFile` raw into `# …` lines (verified).
- Callers pass unsanitized values: `index.ts` ~1285-1289 (launch,
  `name: params.name`) and ~2315-2319 (resume). `SubagentParams` (`index.ts` ~161-200)
  declares both `name` and `cwd` as optional LLM-controlled strings; only `.trim()` is
  applied (`index.ts` ~1808, ~2111), interior `\n` survives, and
  `store.ts` `uniqueName` preserves it (appends `-2` at most).
- `kitty.ts` `sendLongCommand` writes `#!/bin/bash` + preamble + command to a file and
  the tab executes `bash <script>` — an injected line escapes the comment. RCE as user
  on spawn and every resume. Secondary `cwd`→`sessionFile` vector is plausible
  (`agents.ts` `resolveSubagentPaths` uses `join()`, which preserves `\n`).
- Reassuring check: the *command* itself is safe (`shellEscape` on all env vars,
  `createSurface(name)` passes title as argv) — the preamble comment is the only sink.
  Sanitizing at `sendLongCommand` level would cover all three preamble sites at once.

### H1 — CONFIRMED, High stands
- `kitty.ts` `pollForExit`: loop checks sidecars → sentinel file → `readScreenAsync`
  for `__SUBAGENT_DONE__`; the `catch` only re-checks sidecars. No `windowExistsOrNull`
  probe anywhere in the loop. Dead tab ⇒ `get-text` throws forever, no sidecar ever
  arrives (`; echo DONE` died with the shell) ⇒ infinite poll, leaked
  `runningSubagents` entry, no `subagent_result`, resume degrades to steer-into-dead-tab.
  Callers `index.ts` ~1448 (`watchSubagent`) and ~611 (`monitorKeptTab`) both affected.

### H3 — CONFIRMED, High stands
- Writer `subagent-done.ts` uses bare `writeFileSync` for `.exit` (2 sites: auto-exit
  error path, keep-open error path) and `.done` (keep-open path), while `.ask` uses
  `writeAskSignalAtomic` (tmp+rename) — the asymmetry is exactly as reported.
- Reader `kitty.ts` `takeCompletionSidecar` rename-claims `.exit` and **deletes**
  corrupt claims, so a torn rename wins the race and the signal is lost; remaining child
  bytes go to the renamed inode. Keep-open runs have no sentinel fallback (shell stays
  interactive), so a lost `.done` hangs the spawn watcher until tab close. Window is
  small (single small `writeFileSync`) but the consequence is signal loss. Keep High.

### H4 — CONFIRMED, High stands
- `index.ts` `session_shutdown` (~1647+) clears module-level `widgetInterval` /
  `statusInterval` and their `Symbol.for` keys globally — kills surviving sessions'
  widget refresh + status supervision. `latestCtx`/`latestPi` are last-writer-wins
  (`latestPi = pi` at extension load; `latestCtx = ctx` on every `session_start`).
  Threaded-`pi` fixes cover watchers/monitors but not widget/timers. Agree with fix
  direction (per-artifact-dir timer ownership / refcount).

### H5 — CONFIRMED, High stands
- `session_start` (~1590-1645) replays orphan `.ask` + re-attaches **kept** monitors
  only. Launch-time `registerName` stores `{sessionFile, sessionId}` with no `surface`
  for normal runs (verified — `surface` is only added on completion when
  `result.surfaceKept`). `SubagentStore` is per-import (`index.ts` ~555-556), so after
  `/reload` the running map is empty while the old module's watcher is aborted by the
  import-time `POLL_ABORT_KEY` rotation (`index.ts` ~141-156). Live non-kept tab ends
  ownerless: result lost, widget row gone, tab unsupervised. Exactly as reported.

### H6 — CONFIRMED, High stands (easiest High to fix)
- Resume branch (`index.ts` ~2180-2360): running-check (`for r of runningSubagents`
  + kept-tab check + stale-sidecar unlink) → `createSurface` → **`await`
  shell-ready delay** → build/send → `runningSubagents.set`. `reservedNames` is never
  touched on this path (only the spawn path reserves, `index.ts` ~1817). Two concurrent
  `subagent_message({name:"X"})` both pass the guard before either registers ⇒ two `pi
  --session <same file>` processes on one `.jsonl`. The one-line fix (synchronous
  `reserve` before first `await` + re-check after delay) is correct.

### M1 — CONFIRMED, Medium stands (trigger narrower than stated — see note)
- `kitty.ts` `takeCompletionSidecar`: `.exit` rename-claims; `.done` is
  `existsSync` + `rmSync`. Asymmetry verified.
- Note: spawn-watcher and kept-monitor for the *same* run are sequential (kept monitor
  starts after the spawn watcher resolves, `index.ts` ~1860-1878), so the concurrent
  double-consume needs a second writer event (M9's second `.done`) or a
  reload-resurrection overlap — not the steady-state 1s-vs-2s race the text implies.
  Fix (rename-claim `.done` like `.exit`) is still right and also fixes the M9
  double-consume shape. Keep Medium.

### M2 — CONFIRMED, Medium stands
- `index.ts` `deliverPendingQuestion`: both failure restores (`~1418` no-target,
  `~1438` send-throw) do unconditional `renameSync(claim, askFile)`. `claimAskFile`
  (~1375) momentarily removes `.ask`, so a child asking Q2 in that window gets its
  fresh atomic `.ask` overwritten by the Q1 restore. Q2 lost silently. No-clobber
  restore fix is correct.

### M3 — CONFIRMED, Medium stands
- Abort branch returns `{summary: "Subagent cancelled.", error: "cancelled"}`
  (`index.ts` ~1567) instead of throwing; both `.then` handlers (~1880 spawn, ~2383
  resume) call `notifyResultCanonical` unconditionally. `notifications.ts` `notify*`
  call `pi.sendMessage` directly (no try/catch at call sites or inside), so a throw
  during shutdown propagates from `.then` into `.catch` → `notifyErrorCanonical` /
  `pi.sendMessage` can throw again with no handler. Both halves verified.

### M4 — CONFIRMED, Medium stands (nicest catch in the Mediums)
- `parseStatusConfig` (`status.ts` ~143) does `requireObject(config.status, …)` — a
  tabs-only config throws. `config.ts` falls back **only** on missing-file ("Missing
  subagent status config" prefix). Meanwhile `getExtensionConfig()` is called in
  `renderSubagentWidgetLines` (~712), `startStatusRefresh` (~895, ~931), and
  `shouldKeep*` (~399-409) — i.e. inside the TUI render callback and the 1s timer, not
  just tool paths. The inconsistency with `parseTabsConfig` (absent ⇒ defaults) makes
  the fix obvious: same leniency for absent `status`. Keep Medium — UI-loop throws are
  worse than tool-call throws.

### M5 — CONFIRMED, Medium stands
- `session/loadout.ts` `readSubagentLoadout`: object-check + unchecked cast only.
  `launch.ts` `applySandboxToParts`: `if (loadout.toolAllowlist)` skips
  `--no-extensions/--tools` when null. Current spawns always write non-null
  (`buildSubagentToolAllowlist` always returns a joined string), so the vector needs a
  legacy/hand-crafted/child-rewritten sidecar — and the child *can* rewrite it (knows
  `PI_SUBAGENT_SESSION`, has `write`/`bash`). Refuse-or-rederive fix is right. Keep
  Medium (privilege-escalation shape, non-default trigger).

### M6 — CONFIRMED, Medium stands
- `session/registry.ts`: `readNameRegistry` returns `{}` on corrupt (warn-once);
  `registerName` then writes `{[newName]: entry}` — one torn write/disk-full/manual
  edit + one spawn/completion = all prior handles for that spawner session gone
  permanently. Backup-and-refuse fix is cheap and correct.

### M7 — CONFIRMED, Medium stands
- `session/io.ts`: `countSessionEntryLines` counts non-blank lines; `readEntriesAfter`
  puts non-blank in `total` but only parsed in `entries`, returning
  `parsed.slice(afterLine)`. Resume captures baseline with the former (`index.ts`
  ~2237) and slices with the latter (~2367): every torn line before the resume point
  shifts the window by one (miss a new message or include a stale one). The
  `readEntriesAfter` doc comment even recommends the baseline fix. Keep Medium.

### M8 — CONFIRMED, Medium stands
- `agents.ts` ~84: `EXTRA_TOOL_EXTENSIONS` is a module-local `Map`; only the function
  pointer is published on `globalThis.__pi_interactive_subagents` (~106-114). After
  `/reload`, fresh empty map, overwritten global fn. `getToolExtensionPath` returns
  `undefined` → `launch.ts` `applySandboxToParts` silently drops the `-e` path
  (`if (extPath && existsSync(extPath))`). Child runs with a silently narrower toolset.
  `Symbol.for`-backed map fix matches existing precedent. Keep Medium.

### M9 — CONFIRMED, Medium stands
- `subagent-done.ts`: `completionSignaled` is `let` in-memory. `monitorKeptTab`
  (`index.ts` ~611-650) polls the *same* `sessionFile` and any `done` result falls into
  silent-cleanup + `untrackKept` + `clearKeptSurface`. Child-side `/reload` resets the
  flag → next turn-end writes `.done` again → parent unregisters a live tab; later
  `.ask`s orphan until next parent `session_start` recovery. Fix options (monitor
  ignores `.done`, or persisted fired-flag) both sound; note M1's rename-claim makes
  the second `.done` exactly-once but does not stop it from ending supervision — M1
  and M9 are complementary, not duplicates.

### M10 — CONFIRMED as fact, severity should be Low (see Severity adjustments)
- Three variants verified: launch inline (`index.ts` ~1217-1244, ends with
  `PI_SUBAGENT_SURFACE`), resume inline (~2278-2299, `AUTO_EXIT` last, **no**
  `SURFACE`), canonical `buildEnvPrefix` (`launch.ts` ~50-66, `AGENT`-before-`NAME`,
  used by neither — only re-exported via `__test__`, `index.ts` ~971-972). Scrub
  prefix is a literal (`index.ts` ~1276) beside unused `SCRUB_PREFIX`. Impact benign
  today verified: `PI_SUBAGENT_SURFACE` is never read anywhere (`grep` finds only the
  two setters + builder). The AGENTS.md §1 "two places build the same string" callout
  is fair as hygiene.

### M11 — CONFIRMED as fact, severity should be Low (see Severity adjustments)
- `kitty.ts` `sendCommand` = `ls` (pre-check) + `send-text` + `send-key`, all
  `execFileSync`; `closeSurface`/`createSurface`/`readScreen` sync; completion path
  calls `maybeCloseSurface` → `closeSurface` synchronously (`index.ts` ~422, ~1505,
  ~1533). Every steer pays 3 blocking spawns. Async precedent (`kittenAsync`,
  `readScreenAsync`) exists. Pure responsiveness — Low.

### L1 — CONFIRMED, Low stands
- `tools/safe-bash.ts` `hasBlockedSubstitution` comment claims "`$() , ``, `${}`"
  but only collects `$()` and backtick bodies — `${sudo}`/`${IFS}`-style bodies never
  scanned. Verified. `chmod 777 /tmp/x` overblocks (pattern `777\s+\/` matches) and
  `dd if=` blocks read-only uses — verified against the regexes. Comment-fix-or-scan
  fix is right; "not a sandbox" framing already correct.

### L2 — CONFIRMED, Low stands (one nit)
- `plugin/hooks/on-stop.sh` `json_field`: python branch `print(json.load(…).get(…))`
  renders dicts as Python repr; node fallback `console.log(obj)` renders
  `[object Object]`-style/inspect output (nit: `console.log` of an object prints
  `util.inspect`, not literally `[object Object]` — same consequence: non-JSON text in
  the sentinel, shown verbatim as the parent summary). `json.dumps`/`JSON.stringify`
  fix correct.

### L3 — CONFIRMED, Low stands
- `recoverPendingQuestions` synthesizes `startTime: Date.now()` (verified); elapsed
  derives from it (`deliverPendingQuestion` ~1426) ⇒ "asks (0s)". mtime-or-registry
  fix correct, cosmetic.

### L4 — CONFIRMED, Low stands
- `index.ts` ~31 imports `windowExists`; the only liveness uses in the file (~589,
  ~2203) are `windowExistsOrNull`. `kitty.ts` ~218 `windowExists` maps
  control-plane failure → `false` (footgun as documented). Drop-the-import fix right.

### L5 — CONFIRMED, Low stands
- `session/index-cache.ts` `getSessionIndex`: all three branches call `indexDir` —
  the top-level signature never short-circuits, every lookup walks the tree with sync
  `readdir`+`stat`. `lookupSessionIndex` prefix-matches newest-mtime-wins silently.
  Production callers: none (only `session.ts` barrel re-export + `test/test.ts`). The
  barrel re-export is not a use. Quarantine-or-fix recommendation sound.

### L6 — CONFIRMED, Low stands
- `steerSubagent` flattens newlines then `sendCommand` (char-stream); no
  `sendLongCommand`/script-file path for steers. Wrap-break risk is the same class
  `sendLongCommand` was built for. Size-cap doc or temp-file typing both fine at this
  priority.

### L7 — CONFIRMED, Low stands
- No GC found: launch writes `context/*-sysprompt-*`, `context/<name>-<ts>.md`,
  `subagent-scripts/*`; resume writes `subagent-resume/*`; resume mints a new
  `id`+`activityFile` (`index.ts` ~2145, ~2290s), orphaning the prior activity file.
  Sweep-on-`session_start` or keep-last-N both fine.

### L8 — CONFIRMED with framing note, Low stands
- Sentinel `/tmp/pi-claude-<8hex>-done` (`cli/claude.ts` ~38; `id` =
  `Math.random().toString(16).slice(2,10)` at `index.ts` ~1021 ⇒ ~32 bits): predictable
  in world-writable `/tmp`. Note: threat is same-user (child already runs as the user
  with `bash`), so "squattable" overstates — real exposure is transcript spoofing, and
  `copyClaudeSession` (`cli/claude.ts` ~53) copies whatever path the sentinel names
  (basename-jailed destination, unvalidated content/type) into the sessions dir.
- "No loadout ⇒ Claude can't resume" verified: exactly one `writeSubagentLoadout`
  call site (`index.ts` ~1210, pi path); Claude path (~1118-1160) writes none and sets
  no `--tools` allowlist / `PI_SUBAGENT_*` identity env. Spawn-only documentation or a
  Claude loadout both resolve it.

### L9 — CONFIRMED, awareness-only, Low stands
- `subagent-done-pure.ts` `shouldAutoExitOnAgentEnd` ignores `_userTookOver` (says so
  in its own M8 contract comment); caller tracks/resets `userTookOver` regardless.
  User-facing doc nudge is the right-sized fix.

### L10 — CONFIRMED as annotated non-issue
- `/subagent` handler (`index.ts` ~2423+) calls `loadAgentDefaults` directly; the
  `PI_SUBAGENT_ALLOWED` gate lives only in the `subagent` tool path. Risk assessment
  (human invoker, children can't invoke slash commands) is correct. Keep as a note.

### Compat risks — all 7 reasonable, 2 with notes
1. **Mixed-version window lossy — agree.** `deliverPendingQuestion` catch (~1398)
   unlinks non-JSON claims; pre-C3 children write `.ask` non-atomically ⇒ one
   question deletable; same for torn `.exit`. Version-gate or retain-then-retry-once
   is the right mitigation. Note interaction: M2's queue fix and this gate should land
   together (a no-clobber queue holding a torn claim forever is its own bug).
2. **Registry has no schema version — agree.** No `version` field in
   `session/registry.ts`; writers overwrite whole file. Cheap to add now.
3. **Sidecar suffixes reserved, stale claims never swept — agree.** `.consuming-*` /
   `.tmp-*` from crashed processes accumulate (compounds L7); `session_start`
   recovery only handles `.ask` + kept surfaces. Sweep + document.
4. **Symbol.for keys are compat surface — agree.** Keys verified at `index.ts`
   ~137-139 (`pi-subagents/widget-interval`, `pi-subagents/status-interval`,
   `pi-subagents/poll-abort-controller`) + `running-children-count` +
   `__pi_interactive_subagents`. Literal-pinning test is cheap insurance.
5. **Strict config vs forward compat — agree with tension noted.** `status.ts`
   `rejectUnsupportedKeys` hard-fails unknown keys, but AGENTS.md rule 5 *wants* loud
   config failures. Recommend: keep loud for wrong types, warn-and-ignore for unknown
   keys (that's the standard split; M4's absent-`status` leniency is the same spirit).
6. **Seed header `version: 3` hand-tracked — agree.** `session/seed.ts` bakes the
   header; `fork`/`lineage-only` children diverge silently if pi bumps its schema.
   Periodic re-check or seed-via-pi is the fix; Low.
7. **Numeric-only surfaces load-bearing — agree.** `matchFor` (`kitty.ts`) enforces
   `^\d+$`; persisted `entry.surface` is consumed via `windowExistsOrNull`/kept checks
   that regex-guard. Keep the validation on every new use of a persisted handle.

### Tests mapping — sane
Suites/blocks line up with the code seams (`launch.test.ts` preamble/order,
`bugfixes.test.ts` per-finding describes, `test/test.ts` sidecar block). Two notes:
H1/H4/H5/H6 tests need the seams they name (injected liveness fn, timer ownership,
`surface` persistence or limitation-steer, resume reservation) — i.e. the tests are
written against the *fixed* design, which is correct but means they can't be added
before the refactor. H2's test (barrier-forced interleave of `registerName`) cannot
fail as written given sync I/O — rewrite it to assert serialization *if* an async
writer is introduced, else drop it (see Disputed).

---

## Disputed / false positives

### H2 — DISPUTED (effectively false positive in-process; at most a theoretical cross-process note)
- `session/registry.ts` `registerName` is **fully synchronous**: `mkdirSync` →
  `readNameRegistry` (sync read+parse) → mutate → `writeFileSync` tmp → `renameSync`.
  No `await` exists between its read and its write, so two "parallel" `subagent`
  executes in one Node process **cannot interleave inside it** — the event loop can't
  preempt sync I/O. The report's repro ("both `execute` bodies read `{}` before either
  writes; A writes `{A}`, B writes `{B}`") conflates the *pre-await uniqueness read*
  (for `uniqueRunningName`, correctly guarded by the synchronous `reservedNames` set,
  `index.ts` ~1804-1818) with the *write-time read* inside `registerName`, which is
  re-executed after each `await launchSubagent` resolves, sequentially. Trace the real
  order: A reserves → B reserves (distinct names via the set) → A launches (awaits) →
  B launches (awaits) → A `registerName` reads `{}` writes `{A}` → B `registerName`
  reads `{A}` writes `{A,B}`. Nothing lost. Completion-time re-registration (`.then`
  callbacks) is likewise a chain of sync RMWs.
- Cross-process writers would break it, but artifact dirs are per-spawner-session
  (nothing in the codebase runs two writers against one registry file in production).
- Recommendation: **remove or demote to Low/info** ("serialize registry writes if a
  second writer ever appears; consider per-name files then"). Do **not** add a
  mutex/queue for a race that can't fire — dead synchronization is its own bug farm.
  The H2 regression test as specified (barrier-forced interleave preserving both keys)
  **passes on the current code**, so it pins nothing.

---

## Severity adjustments

| # | Filed | Suggested | Why |
|---|---|---|---|
| H2 | High | Disputed → Low/info or drop | No trigger in-process (see above); sync RMW is atomic on the event loop |
| M10 | Medium | **Low** | Benign verified: `PI_SUBAGENT_SURFACE` is write-only (never read); order cosmetic. Report itself says "benign". Hygiene, not a bug |
| M11 | Medium | **Low** | "Responsiveness only" per the report; no correctness/data-loss angle. 3 sync spawns per steer is wasteful, not dangerous |
| C1 | Critical | Critical (unchanged) + widen scope | Fix must cover the **third** preamble site (Claude inline, Missing #1), ideally by sanitizing in `sendLongCommand` |
| M1 | Medium | Medium (unchanged) | But narrow the trigger to second-`.done`/reload-overlap rather than steady-state 1s-vs-2s race |
| L8 | Low | Low (unchanged) | But reframe "squattable" — same-user threat model; the copy-any-path + no-loadout halves are the real content |

No other severity changes. H1/H3/H4/H5/H6 are correctly High (hang, signal loss,
cross-session breakage, result loss, transcript corruption).

---

## Missing issues (not in the report, or under-covered)

1. **C1 fix misses the Claude preamble (High-importance gap in a Critical finding).**
   `index.ts` ~1133-1140 builds the Claude launch preamble **inline**
   (`` `# Claude Code subagent launch script for ${params.name}` `` + Generated/Surface
   lines) and never calls `scriptPreambleFor`. Sanitizing `scriptPreambleFor` per the
   suggested fix leaves this vector open, and the C1 regression test (written against
   `scriptPreambleFor`) would pass while the RCE persists. Strongest fix: sanitize at
   the sink — strip `[\r\n]` in `sendLongCommand`'s preamble handling (`kitty.ts`) —
   *plus* validate `name`/`cwd` at the tool boundary. Test all three preamble sites,
   not just the helper.
2. **Completion path does two full sync reads of potentially large transcripts.**
   `watchSubagent` success path calls `getNewEntries(sessionFile, 0)` (full
   parse, `index.ts` ~1514) and `summarizeSessionStats` re-reads the file; resume
   completion re-reads again (~2367). `readEntriesAfter` was built to halve resume
   reads (its doc comment says so) but the completion path never adopted it. Sync
   multi-MB JSON parses on the extension host per completion — perf-only, Low, suggest
   folding into the L11/M11 cleanup wave.
3. **`sendCommand` fails closed on control-plane unknown — no retry for steers.**
   `kitty.ts` `sendCommand` throws when `windowExistsOrNull` returns `null` (socket
   hiccup), and `steerSubagent` surfaces that as an error to the model with no retry,
   while the question path (`deliverPendingQuestion`) retries next tick by design.
   Asymmetric robustness; transient hiccup ⇒ model-visible steer failure. Low;
   consider one retry or queue-and-retry for steers.
4. **Corrupt-claim drops are silent (observability gap across M1/M2/M3/H3/compat-1).**
   Every "drop as corrupt" path (`takeCompletionSidecar` fall-through,
   `deliverPendingQuestion` unlink, compat-1's version-gate) discards without a
   `console.error`/artifact. Torn-signal bugs are then undebuggable in the field.
   Low; log-and-count every corrupt drop.
5. **Resume's stale-sidecar unlink is check-then-act against a live previous run —
   safe today only by sequencing.** `index.ts` ~2218 unlinks `.done`/`.exit` before
   relaunch; correct only because resume is unreachable while a watcher lives (running
   + kept guards above it). If H6's reservation lands, assert the reservation *before*
   the unlink so the ordering invariant is structural, not coincidental. Note for the
   H6 implementer, not a separate fix.

What I checked and found **not** to be issues (so nobody re-files them): the
`; echo '__SUBAGENT_DONE_'$?'__'` sentinel vs `/__SUBAGENT_DONE_(\d+)__/` regex agree
byte-for-byte; `shellEscape` correctly neutralizes `\n` inside single quotes so `cwd`
is safe everywhere *except* the preamble comment; `createSurface(name)` title path is
argv (safe); `resolveResumeLaunchBehavior` always `autoExit:true` so resume's
conditional `AUTO_EXIT` push always fires (consistent, if oddly written).

---

## Recommended fix order (top 10)

1. **C1 (+ Missing #1)** — preamble injection (RCE). Sanitize at the sink
   (`sendLongCommand`: strip `[\r\n]` per preamble line) *and* validate
   `name`/`cwd` at the tool boundary; cover all three preamble sites (launch, resume,
   **Claude inline** ~1136). Regression test per site. Only Critical; only RCE.
2. **H6** — resume reservation. ~5 lines (`reserve` before first `await`, re-check
   guards after the shell-ready delay, release on failure). Prevents `.jsonl`
   corruption; cheapest High.
3. **H1** — tab-death detection in `pollForExit` (liveness probe every tick or after K
   consecutive `get-text` failures; `false` ⇒ error result, `null` ⇒ keep polling per
   N3). Ends silent permanent hangs + leaked widget rows.
4. **H3** — atomic `.exit`/`.done` writes child-side (reuse `writeAskSignalAtomic`
   pattern). Ends torn-signal loss. Pair with M1 (rename-claim `.done` parent-side)
   in the same change — they're the two halves of one protocol fix.
5. **M4** — absent `status` ⇒ defaults (mirror `parseTabsConfig`); safe/cached config
   in render + timer paths. Only finding where a user config breaks the whole TUI
   rather than one tool call.
6. **H5** — persist `surface` for running runs at launch + re-`watchSubagent` on
   `session_start` (with stale-sidecar hygiene), or document loudly with a
   `subagent_status` orphan steer. Ends "subagent vanished after reload".
7. **M5** — validate loadout on read (`toolAllowlist` must be non-empty string or
   refuse resume). Closes the sandbox-escape shape; small.
8. **H4** — per-session timer ownership (map keyed by artifact dir / refcount) + route
   widget to owning ctx. Ends cross-session breakage.
9. **M2 (+ compat-1 together)** — no-clobber claim restore with a pending queue; land
   the mixed-version retain-then-retry gate in the same change so the queue can't
   entomb a torn claim forever.
10. **M6** — back up corrupt registry (`*.corrupt-<ts>`) instead of overwriting; merge
    salvageable entries. One-line-ish, prevents permanent handle loss.

Next wave: M9 (kept second-`.done`), M7 (`readEntriesAfter` baseline), M8
(`Symbol.for`-backed tool map), M10+M11+L7 (hygiene/perf/GC bundle), compat pins
(symbol-key literals, unknown-config-keys warn, suffix sweep), then L1–L6/L8 as
available. Do **not** schedule H2 work beyond closing it as disputed.
