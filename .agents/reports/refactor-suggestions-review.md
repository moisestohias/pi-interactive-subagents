# Review: refactor-suggestions.md (v3.7.2, `index.ts` ~2629 lines)

Reviewed against source at `pi-extension/subagents/` (line counts confirmed:
`index.ts` 2629, `status.ts` 564, `activity.ts` 511, `kitty.ts` 475,
`launch.ts` 227, `launch-types.ts` 9, `agents.ts` 332, `store.ts` 207,
`notifications.ts` 141, `widget.ts` 140, `format.ts` 106). No source edited.
All `file:line` refs below were re-checked; disagreements are flagged, not assumed.

---

# Verdict

**Strong endorse of the direction; do not merge the plan verbatim.** The diagnosis
is correct — `index.ts` is a migration-completion problem (~1500 lines of behavior
still inline + ~40 wrappers re-exporting canonical homes), launch/resume builders
have genuinely drifted, and the phased "snapshot first, byte-identical through
phase 3" discipline is exactly right per AGENTS.md rule 2. Line references are
trustworthy (all spot-checked within ±30 lines; one drift noted in T5).

But the doc overstates three things and understates four compat risks:

- **Overstated:** "every wrapper is zero-logic" (T1 — at least 6 wrappers carry
  adapter logic), "resume wording drift is accidental" (T4 — partly intentional),
  "~12 regex compiles per file is a problem" (S7 — it's spawn-time trivia; the
  robustness framing is the honest one).
- **Understated risks:** (1) S10 alias deletion breaks `test/integration/harness.ts`;
  (2) `formatDuration` deletion breaks `test/format.test.ts:31-33`;
  (3) S8's trilogy merge changes the `__test__` surface that `test/test.ts` pins;
  (4) T4's proposed `cleanupClaudeSentinelFiles` duplicates the existing
  `cleanupClaudeSentinel` in `cli/claude.ts`.
- **One factual correction that strengthens the case:** T2's env-order drift is
  *worse* than described — canonical vs inline vs resume disagree three ways
  (see T2 evidence). Functionally harmless (env order is unordered) but it proves
  the "two builders" hazard is live, not theoretical.
- **One dead-code correction:** S4's `|| "resume"` fallback can never fire because
  `slugifyName` never returns `""` (`names.ts:12` falls back to `"subagent"`).
  The cleanup is still right; the reasoning needs updating.

Net: endorse phases 0–3 essentially as written (with the corrections below),
do phase 4 in a reduced validators-first shape, and push T7-splits / P5 /
S10-deletions / S13-generalization to "lazy, possibly never."

---

# Endorsed (with brief why)

## T2 — Make `launchSubagent` use `launch.ts`. STRONGEST ENDORSE, highest risk-reduction.
Verified drift is real and worse than the table says:

- `launch.ts:50-66` (`buildEnvPrefix`) orders `AGENT` *before* `NAME`; inline
  launch (`index.ts:1241-1244`) orders `NAME` *before* `AGENT`
  (`PI_SUBAGENT_NAME` at ~1241, `PI_SUBAGENT_AGENT` guarded at ~1243); resume
  (`index.ts:2284-2289`) orders `AGENT` before `NAME` (matching canonical,
  disagreeing with inline launch). Three builders, two orders.
- Scrub prefix hardcoded at `index.ts:1277` and `index.ts:2307` vs canonical
  `SCRUB_PREFIX` (`launch.ts:26`). Confirmed byte-identical strings, two homes.
- Task artifact inline at `index.ts:1254-1259` duplicates `writeTaskArtifact`
  (`launch.ts:174-188`); resume-msg file inline at `index.ts:2262-2272` duplicates
  `writeResumeMessageFile` (`launch.ts:189-201`).
- `buildPiParts` (`launch.ts:211-225`) exists and is **never called** by the launch
  path, which assembles `parts` inline from `index.ts:1196` onward.
- Claude preamble hand-built at `index.ts:1136-1140` vs `scriptPreambleFor`
  (pi path uses `scriptPreambleForCanonical` at ~1285). Backends already disagree.
- Timestamp pattern confirmed 5× 19-char (`launch.ts:102,180,190`,
  `index.ts:1254,2264`) + 23-char+`Z` variant (`index.ts:1044`).

Shell quoting is load-bearing (rule 2) so this is the one duplication that can
cause a real incident. The `LaunchPlan` proposal is the right shape. Gate on
Phase-0 snapshots exactly as proposed.

## T3 — Unify resume assembler with launch. ENDORSED, do with T2 as one PR.
Resume block confirmed at `index.ts:2240-2330` (parts ~2245-2260, msg file
2262-2272, env 2278-2300, cd/command 2305-2307). It duplicates everything in T2
with the same order disagreement noted above. Constraint for the implementer:
`buildPiResumePlan` must take only assembly (parts/env/cd/command/script paths);
the guards stay in the handler — kept-tab double-open refusal (~2215-2238),
stale `.done`/`.exit` unlink (~2240), loadout-refusal (~2252), `entryCountBefore`
counting. Doc respects this; keep it explicit in the PR. Minor nit:
`buildEnvPrefix` already has first-class `autoExit: boolean` — no need to route
resume's `AUTO_EXIT=1` through `extra`.

## T6 — Stop inverting notification strings in renderers. ENDORSED, raise priority.
The coupling is confirmed and is a *silent-breakage* hazard, not hygiene:

- Renderer strips at `index.ts:2503-2514` (chained `.replace()` + dynamic
  `new RegExp` with inline escape); content built at
  `notifications.ts:32-49` (`resolveResultPresentation`).
- `escapeRegExp` exists at `agents.ts:144` but the renderer doesn't use it
  (only internal use at `agents.ts:150`) — S9's observation is correct.
- `notifyResult` details (`notifications.ts:60-78`) carry `name/task/agent/
  exitCode/elapsed/sessionFile/sessionId/errorMessage/claudeSessionId/stats`
  but **no `summary`** — so the renderer's "prefer `details.summary`" step
  genuinely is a one-line addition plus fallback, as claimed. Old persisted
  messages keep the stripping path. Correct and compat-safe.

Do S9 as part of T6, not separately (T6 deletes the regex S9 would fix).

## T1 — Delete wrappers. ENDORSED with a correction to the "zero-logic" claim.
Wrapper block confirmed (`index.ts:233-830`, ~40 `function`s plus `ICON_*` at
354-357 duplicating `widget.ts:13-16` and `ACCENT/RST` at 679-680 duplicating
`widget.ts:10-11`). `test/test.ts` imports only via `__test__` (confirmed
~28 `__test__` call sites, e.g. `test/test.ts:1159,1300`), so re-pointing
`__test__` at canonicals needs no test changes. AGENTS.md already blesses
wrappers "only when `__test__` compat needs it" — T1 is the completion of that
contract. **Correction:** at least six wrappers are adapters, not aliases, and
the PR must move their logic, not just delete:

- `renderSubagentWidgetLines` (`index.ts:703-713`) maps `RunningSubagent → WidgetRow`
  and injects `getExtensionConfig().status.enabled` — real logic.
- `buildSubagentToolAllowlist` (`index.ts:761-769`) injects
  `spawningTools: SPAWNING_TOOLS` — real default.
- `formatWidgetRightLabel` (`index.ts:480-482`) drops the canonical's 2nd `opts`
  arg (cli/statusEnabled) — call sites silently lose the claude `running…` label.
- `shouldKeepSurface*` family (`398-413`) reads `getExtensionConfig()` fresh —
  new logic, not delegation (keep, but move to `keep.ts` call sites or leave).
- `maybeCloseSurface` (`422-426`) fallback, `keptTabAlive` (`585-593`) try/catch —
  see S5, both have homes already.
- Type-shimming casts (`parseAgentDefinition … as AgentDefinition | null`) — trivial
  but must be preserved at the new call sites or dropped deliberately.

Recommendation: split T1 into (a) pure-alias deletion (mechanical, ~30 wrappers)
and (b) adapter relocation (the six above, each moved with its logic + comment).
Also: prefer importing canonicals under clean names
(`import { buildEnvPrefix } from "./launch.ts"`) over propagating the
`*Canonical` suffix to every call site — the suffix is migration scar tissue and
T1 is the moment to remove it.

## T8 — Centralize sidecar IO. ENDORSED with two constraints.
Five implementations confirmed: `kitty.ts:takeCompletionSidecar` (rename-claim,
corrupt-consumes), `index.ts:1375-1386 claimAskFile` (rename-claim),
`subagent-done.ts:writeAskSignalAtomic` (tmp+rename write),
`session/registry.ts:registerName` (tmp+rename write),
`activity.ts:writeSubagentActivityFile` (tmp+rename write). Rule 3 belongs in one
file. Constraints:

1. **Keep the new module dependency-free** (`node:fs`/`node:path` only).
   The child side (`subagent-done.ts`) runs in the child process — importing a
   module that transitively pulls the `session.ts` barrel (`io/index-cache/
   registry/loadout/seed/stats`) into the child bundle is the wrong trade.
2. **Preserve the deliberately different policies**, which are not all
   "drop on corrupt": `deliverPendingQuestion` *restores* the claim
   (`renameSync(claim, askFile)`) when there is no pi target or notify throws
   (`index.ts:1408-1440`) — that's a claim-restore, not a corrupt-policy, and
   `readJsonClaim { onCorrupt }` doesn't cover it. Registry reads tolerate corrupt
   as `{}` (never throw); sidecar reads consume-and-drop. Each migration needs
   its existing test (`test/bugfixes.test.ts`, `test/session-status-split.test.ts`).
   Also note `.done` in `kitty.ts` is `rmSync`-without-claim while `.exit` claims
   via rename — central `takeSidecar` should claim both.

## S1/S2/S11/S12 — trivial, correct, fold into Phase 1.
- **S1:** confirmed `extensionConfig/statusConfig/tabsConfig` (`index.ts:469-471`)
  are written and never read; every call site uses `getExtensionConfig()` fresh;
  `refreshConfigCache` is called once (`index.ts:1594`, session_start) and
  `__test__` doesn't export any of it. Safe to delete. Adjustment: keep a loud
  log in session_start (today `safeConfigInit` logs invalid-config at import);
  pure `invalidateExtensionConfigCache()` preserves refresh but drops the startup
  warning. Keep the warning, drop the dead lets.
- **S2:** dup constants confirmed (see T1). Delete, import from `widget.ts`.
- **S11:** inline `resolve(r.sessionFile) === resolve(sessionPath)` (`index.ts:2174`)
  duplicates `store.ts:60-70 findRunningBySessionFile` (same compare, only the
  store copy has try/catch). Simpler than a new `sameSessionFile` helper: call
  `subagentStore.findRunningBySessionFile(sessionPath)` directly — index's
  `runningSubagents` **is** `subagentStore.running` (`index.ts:555`), so the loop
  is redundant, not just duplicated.
- **S12:** `void SUBAGENT_CONTROL_TOOLS_CANONICAL` (`index.ts:756`) + local
  `DEFAULT_SUBAGENT_TOOLS` alias (`755`) confirmed; no test usage. Delete locals,
  import canonicals under clean names (same T1 naming point).

## S5 — `maybeCloseSurface` required param + `keptTabAlive` into store. ENDORSED, easier than stated.
All three callers (`1505,1533,1553`) already pass `running.keepSurface`
explicitly — there are **zero** legacy omitted-arg call sites, not two. Making
the param required is a signature-only change. `keptTabAlive` (`585-593`) is
`windowExistsOrNull(s) !== false` + try/catch→`true`; `store.findKept`
(`store.ts:130-155`) already try/catches its injected `exists` — the index
try/catch is the duplicate. Move the N3 comment + default into `store.ts`
(`exists = (s) => windowExistsOrNull(s) !== false`) and delete the wrapper.
Do with T1.

## S3 — timestamp helper. ENDORSED with a shape note.
Occurrences confirmed (see T2). Note the 23-char variant (`index.ts:1044`,
`slice(0,23)+"Z"`) is a *different shape* (sortable session filename + `Z`),
not just a different length — the helper needs `timestampTag(now?, len?)` for
artifacts **plus** a separate `sessionTimestamp()` (or explicit `+ "Z"`) so the
next reader doesn't "unify" the session filename into artifact format. Lives in
`format.ts` — agreed (clocks live there).

## P3 — `renderers.ts`. ENDORSED.
Renderer registrations confirmed at `index.ts:2453,2564,2593`; bodies touch only
`Box/Text/theme` + `formatElapsed/formatUsageSegments/contextWindowFor` — no
store/kitty. Clean cut, pairs with T6 in one PR.

## "What NOT to abstract" — ENDORSED wholesale.
No `utils.ts` (S3→`format.ts` is the right call), no tool base class (shared
envelope already in `notifications.ts`), no registry ORM (compat boundary),
`launch-types.ts` stays deleted. This section is the best guardrail in the doc.

---

# Disputed / risky (with why + code ref)

## D1. S10 alias deletion — DISPUTED as written; would break the integration harness.
`createSurfaceSplit` (`kitty.ts:173-183`), `isMuxAvailable` (`62-64`),
`muxSetupHint` (`77-79`), `isSurfaceAvailable` (`67`) are `@deprecated` but
**live**: `test/integration/harness.ts:26,40,83,196` imports and calls
`isMuxAvailable`/`createSurfaceSplit`. Deleting them breaks
`npm run test:integration`. The 71-line `legacy-branch.ts` + barrel re-exports
(`session.ts:37-41`) + quarantine test (`test/session-status-split.test.ts:85-94`)
is likewise self-contained and harmless. **Do not delete in a refactor PR.**
At most: collapse index's private `kittyUnavailableResult → muxUnavailableResult`
alias (`index.ts:440-443`, zero test usage confirmed) and leave the rest
quarantined. Revisit only with a dedicated compat-break PR that updates the harness.

## D2. S13 `getEnvIntMs` generalization — DISPUTED (YAGNI).
`getShellReadyDelayMs` (`index.ts:371-377`) has exactly two call sites
(`1072,2247`, both launch/resume shell-ready sleeps) and no second tunable
exists. A generic `getEnvIntMs(name, def, {min})` in `config.ts` optimizes for a
copy-paste that hasn't happened. **Counter-proposal:** move `getShellReadyDelayMs`
as-is into `config.ts` (it *is* config, that half of S13 is right) without
generalizing; extract the generic the day a second env-tunable lands. Keep the
`__test__` export working (`test/test.ts:2819-2842` pins it).

## D3. T5 full-DI handlers — RISKY scope; split into validators-now, DI-later.
Handler sizes confirmed (`subagent` execute at `index.ts:1696-1980`,
`subagent_message` at `2044-2400`, `/subagent` command at `2423` — note doc says
2403, actual is 2423). The pure policy inside is real and worth extracting:
self-spawn check (~1700), allowlist gating (~1730-1770),
steer-vs-resume dispatch incl. the ambiguity rule (`2130-2145`), loadout-refusal.
But the proposed `SpawnDeps { launch, store, registry, notify, widgets }` DI
plumbing couples T5 to P1's `lifecycle.ts` cut — two prisms on the same
watcher/registry/kept-tab fan-out (`~1850-1900` spawn watcher, `~2350-2395`
resume watcher). Done as separate PRs they will pass the same state back and
forth; done as one mega-PR it's unreviewable. **Counter-proposal:** Phase 4a
extracts pure validators (`validateSpawnParams`, `decideSteerResume`, keep the
`__test__` indirection for them) with direct unit tests; Phase 4b moves the
effectful executes + `lifecycle.ts` together once 4a is green. The `/subagent`
command (`loadAgentDefaults` + `sendUserMessage`) and `subagents_list` move as-is
anytime — they're trivial.

## D4. T7 module splits + P5 validator unification — DEFER, don't schedule.
Sizes confirmed, seams are as described, `formatElapsedDuration` alias in
`status.ts:231-233` confirmed as one more T1-instance. But all three modules are
stable and internally coherent; the splits buy readability at the cost of import
churn across `test/*` (barrels mitigate, not eliminate). Stronger objection on
P5: `status.ts:80-130` validators **throw** (`invalidStatusConfig …: never`)
while `activity.ts:60-110` validators **return strings** (`…: string | null`) —
unifying forces a policy change on one side, and the third "dialect"
(`agents.ts:148-151` regex-per-key) serves single-line frontmatter, not nested
schema. The doc already labels P5 "optional … when the next key is added" —
**take that seriously: do not schedule P5, and do T7 lazily file-by-file only
when a change touches that file.** Update the AGENTS.md "New config key" recipe
only if/when the split lands (Phase 6 ordering is right).

## D5. P2 `runtime.ts` — DEFER to the tail of Phase 4, narrow the surface.
Keys confirmed in two files: `WIDGET/STATUS_INTERVAL_KEY`, `POLL_ABORT_KEY`
(`index.ts:137-155` rotation block), `RUNNING_CHILDREN_COUNT_KEY` (`index.ts:659`,
reader in `subagent-done-pure.ts:15`), plus `__pi_interactive_subagents`
publisher in `agents.ts:110-118` (doc says "from index.ts" — it's actually in
`agents.ts`). Centralizing is nice (rule 4 enforced by ownership, not comments)
but it relocates **import-time side effects** (clearInterval+abort+new-controller
at import; fresh-controller-if-aborted at session_start `~1596-1604`) and the
M1 scoped-teardown invariant (shutdown tears down only that session's watchers,
never the global controller). High care / low payoff — do last, keep the exact
ordering, and keep `runtime.ts` free of `agents.ts` imports (cycle risk: agents
publishes into the global; runtime must not import agents).

## D6. T4's new `cleanupClaudeSentinelFiles` — duplicates existing helper.
`cli/claude.ts` already exports `cleanupClaudeSentinel` (unlink sentinel +
`.transcript`, both swallowing). T4 should call it (including from a `finally`,
as proposed) rather than adding `cleanupClaudeSentinelFiles` to `results.ts`.
Related: `extractClaudeSummary` needs `readScreenAsync` — it is async IO, not
"pure + tiny IO." Shape the module as `results.ts` = sync wording/extraction
from already-read inputs + one async `extractClaudeSummary` that takes a
screen-reader fn (injectable for tests), mirroring how `steerSubagent` injects
`send` (`index.ts:832-849` — a good existing seam the doc doesn't cite).

## D7. S8 trilogy merge — ENDORSE direction, flag `__test__` impact.
`resolveEffectiveSessionMode(params…)` ignoring `_params` confirmed
(`agents.ts:279`, `index.ts:314-318` same for interactive). A single
`resolveLaunchPolicy` table is cleaner. But all three names are exported via
`__test__` (`index.ts:962-964`); check `test/*` pinning before removing keys —
keep deprecated aliases (`resolveLaunchBehavior = (p,d) => resolveLaunchPolicy(d).…`)
until tests migrate. Low priority regardless (three small pure functions).

## D8. S4 reasoning + S7 benefit framing + S6/S10-test notes (minor corrections).
- **S4:** `slugifyName` (`names.ts:3-12`)Gmail never returns `""` (falls back to
  `"subagent"`), so `slugifyName(name) || "resume"` (`launch.ts:194`,
  `index.ts:2268,2310`) is dead fallback, not live divergence. Route resume-msg
  naming through `names.ts` (`contextArtifactName`) and resume-script naming
  through `resumeScriptName` (`names.ts:22-28`, already defaults correctly) —
  and delete the dead `|| "resume"`. Same outcome, honest rationale.
- **S7:** ~15 `getFrontmatterValue` calls per `parseAgentDefinition`
  (`agents.ts:203-222`) each compiling a `RegExp` — confirmed, but this runs once
  per agent file at spawn/list time; perf is irrelevant. Sell it as robustness +
  cheaper field-adds (keep `getFrontmatterValue` wrapper; zero test usage of it
  directly, so safe), Phase 5.
- **S6:** cycle analysis confirmed acyclic (`launch.ts → agents.ts →
  {paths,names}`; `agents.ts` never imports launch). `launch-types.ts` has exactly
  one importer (`launch.ts:15`) and zero test importers — safe to delete with the
  AGENTS.md map-line update. Endorsed; just don't forget the map line.
- **S10/formatDuration:** deletion breaks `test/format.test.ts:31-33` (only caller
  is its own test — confirmed). Either adopt it at the three clock call sites or
  delete it *and* update that test. Doc omits the test edit — add it.

---

# Priority adjustments

1. **Up: T6 (renderer coupling).** A wording edit in `notifications.ts` silently
   breaks display in `index.ts` renderers today with no test pinning the pair.
   Cheap, safe, pairs with P3 in one PR. Should ride Phase 3 *first*, or even
   Phase 1.5.
2. **Up: S5, S11, S12, S2.** Four trivially-safe deletions/folds with zero caller
   fixes (S5 has no legacy callers; S11's loop is redundant with the store;
   S12/S2 are alias deletions). Belong in Phase 1, not scattered.
3. **Down: T7 splits, P5.** Lazy/incremental only (see D4). They add the most
   diff-lines for the least risk-reduction and threaten the "every phase green"
   story with import churn.
4. **Down/split: T5.** Validators now (pure, directly unit-testable, no DI);
   effectful-handler move only together with P1 lifecycle (see D3).
5. **Down: S10 deletions, S13 generalization.** S10 risks the harness for 71
   quarantined lines (see D1); S13 generalizes a single caller (see D2).
   Both are "possibly never" — say so explicitly.
6. **Reorder: T8 after Phase 2, not with it.** Sidecar centralization touches
   watcher hot paths (`pollForExit` ticks, `.ask` delivery, registry writes);
   land it on the already-unified launch/resume world, with per-callsite policy
   tests, not in the same PR as command-assembly surgery.
7. **Keep: Phase 0 first, exactly as specified** (pi launch + claude launch +
   resume snapshots in `test/launch.test.ts`, which today covers builders in
   isolation only — confirmed). Add one assertion the doc omits: env-key *order*
   for launch vs resume (pins the T2 disagreement deliberately, so the
   unification PR shows the intended single order as a reviewed diff, not an
   accident).

---

# Missing opportunities (not in the doc)

## M1. Resume error path bypasses `notifications.ts` (live rule violation).
`index.ts:2397` calls `pi.sendMessage({ customType: "subagent_result", … })`
directly in the resume-watcher's `.catch`, while every other result path goes
through `notifyResultCanonical`/`notifyErrorCanonical` (`1880,1897,2383`).
AGENTS.md assigns `notifications.ts` sole `sendMessage` ownership. Route the
resume catch through `notifyErrorCanonical` (one-line fix, fold into T5/P1 work).
This is the kind of second-envelope the whole refactor exists to kill — it
should be in the doc.

## M2. `RunningSubagent` vs `RunningEntry` type duplication.
`index.ts:519-565` defines `RunningSubagent` + `KeptTab` locally and casts
through `store.ts:18-35` (`RunningEntry`/`KeptTab`) at every boundary
(`runningSubagents` map cast at `555`, `keptTabs` at `580`, `findKeptTab`,
`trackKeptTab`, `steerSubagent`'s fake `as RunningSubagent` at `~2230`). Two
sources of truth for the same shape — the exact "rename in one place silently
shadows" hazard T1 cites for functions. Unify on one interface (extend the
store's with optional769 fields) when T5/P1 moves the handlers; until then note
it as a known hazard.

## M3. Cap `__test__` growth; new tests import homes directly.
`__test__` (`index.ts:952-999`) exports ~40 keys and the plan keeps it growing
(S8/S13 would add more). The better pattern already exists:
`test/launch.test.ts` imports `launch.ts` directly. Make it the rule for all new
suites (`results.test.ts`, `renderers` snapshots, handler validator tests import
their homes; `test/test.ts` keeps `__test__` for legacy). Add to Phase 6 docs so
T1's win doesn't regress.

## M4. Env contract (`PI_SUBAGENT_*`) has no single table.
Launch builds it (`index.ts:1226-1247`, resume `2278-2300`), `subagent-done.ts`
reads `PI_SUBAGENT_NAME/AGENT/SESSION/ID/ACTIVITY_FILE/SURFACE/AUTO_EXIT`
(+ legacy `KEEP_TAB` scrub in three places), `agents.ts:getSubagentAllowlist`
reads `PI_SUBAGENT_ALLOWED`. After T2/T3 the *builders* unify but the contract
stays tribal knowledge. Cheap fix: a comment-table (or `docs/` row) listing
every `PI_SUBAGENT_*` key, writer, reader, and compat status — prevents the next
"add a var in one builder" incident. Fold into Phase 2 or 6.

## M5. Teardown/recovery scoping has no unit test.
M1 scoped-teardown (`index.ts:1651-1695`, matchesDir loop) and session_start
recovery (`1600-1648`, ask-recovery + kept reattach) are the most
reload-sensitive code in the repo and are only exercised via kitty integration.
P1's `teardownSession(deps, artifactDir)` / `recoverSession(deps, artifactDir, pi)`
with a fake store makes them pure unit tests — call this out as the acceptance
criterion for P1, not just "testable."

---

# Recommended order (top 8)

1. **Phase 0 — snapshots (no source changes).** Full `piCommand` for pi launch
   (model+identity+tools+skills+spawning), claude launch, and resume command in
   `test/launch.test.ts`; assert env-key order explicitly (pins the T2
   three-way disagreement so unification is a reviewed choice).
2. **Phase 1 — T1a (pure-alias deletion) + S1/S2/S5/S11/S12.** Re-point call
   sites at canonical imports under clean names, delete ~30 wrappers + triple
   cache + dup constants, make `keepSurface` required, call
   `findRunningBySessionFile`, drop `void …CANONICAL` aliases. `npm test` green;
   `index.ts` −400 lines, zero behavior change.
3. **Phase 1.5 — T1b (adapter relocation) + T6 + P3 + S9.** Move the six adapter
   wrappers with their logic; add `summary` to `notifyResult` details, switch
   renderers to `details.summary` with stripping-fallback, move the three
   renderers (+ six `renderCall/renderResult` closures) to `renderers.ts`,
   reuse `escapeRegExp` only in the fallback. Renderer output pinned by existing
   `test/test.ts` assertions (+2-3 new if gaps).
4. **Phase 2 — T2+T3 (+ S3/S4/M4).** `buildPiLaunchPlan`/`buildPiResumePlan` in
   `launch.ts` (stay in `launch.ts` — defer the P4 split until the file actually
   doubles), migrate launch + resume call-site by call-site against Phase-0
   snapshots; fold timestamp/slug helpers + env-contract table into the same diff.
   Resolves the live second-builder violation.
5. **Phase 3 — T4 (+ M1).** `results.ts` with `summaryFallback/extractPiSummary/
   extractClaudeSummary` (async screen-reader injected), reuse
   `cli/claude.ts:cleanupClaudeSentinel` in a `finally` (no new cleanup fn),
   preserve the launch-vs-resume wording distinction via the `label` param;
   route the resume `.catch` through `notifyErrorCanonical`.
6. **Phase 4a — T5 validators.** `validateSpawnParams` / `decideSteerResume`
   (+ ambiguity rule) as pure functions with direct unit tests; no DI, no moves.
7. **Phase 4b — T5 executes + P1 (+ P2-tail, M5).** `handlers/` + `lifecycle.ts`
   (+ `runtime.ts` last) as one coherent cut: `launchAndWatch`,
   `teardownSession` (fake-store unit test proving M1 scoping),
   `recoverSession`, `monitorKeptTab`/`watchSubagent` orchestration. Gated by the
   kitty integration suite. `index.ts` lands at ~350 lines of registration.
8. **Phase 5+ — lazy only.** T8 (dependency-free `session/sidecars.ts`, per-policy
   migrations with tests), T7 one file at a time when touched, S6/S7/S8 with
   compat aliases + test updates, Phase 6 docs sync (AGENTS.md map:
   `handlers/`, `lifecycle.ts`, `runtime.ts`, `renderers.ts`, `results.ts`,
   `session/sidecars.ts`; `launch-types.ts` removal; "new tests import homes"
   rule per M3). **Explicitly not scheduled:** P5 unification, S10 deletions,
   S13 generalization.

**Standing guardrails (doc's do-not-do list, endorsed):** byte-identical commands
through Phase 2; `session.ts` barrel intact; no `__test__` key removal (re-point
only); no registry/sidecar format change (rule 3); no watcher-semantics change
(fire-and-forget stays).
