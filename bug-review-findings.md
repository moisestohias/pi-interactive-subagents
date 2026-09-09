# Bug Review Findings — pi-interactive-subagents

## Summary

**Revision reviewed:** `27995a8` (`Sync docs with kept-tab steering…`, 2026-09-09) **plus uncommitted worktree changes** (a parallel `refactor-reviewer-v2` was active; files were read as-is, no blocking).

**Worktree state observed (`git status --short`, 2026-09-09 ~20:22 UTC+1):**
- Staged deletions: `agents/worker.md`, `agents/scout.md`, `agents/researcher.md` (i.e. `D ` in index — staged, not just missing on disk).
- Staged modifications: `package.json`, `pi-extension/subagents/index.ts`, `kitty.ts`, `session.ts`, `status.ts`, `subagent-done.ts`; staged deletion `pi-extension/subagents/tmux.ts.archived`.
- Untracked (refactor in progress): `pi-extension/subagents/agents.ts`, `cli/`, `config.ts`, `format.ts`, `keep.ts`, `launch-types.ts`, `launch.ts`, `names.ts`, `notifications.ts`, `paths.ts`, `session/`, `status-bridge.ts`, `store.ts`, `subagent-done-pure.ts`, `widget.ts`, `test/format.test.ts`, `test/launch.test.ts`, `test/names-keep.test.ts`, `test/session-status-split.test.ts`, `test/store-notifications.test.ts`.
- Mtimes (most relevant): `index.ts` 20:21:07, `subagent-done.ts` 20:21:22, `kitty.ts` 20:17:03, `status.ts` 20:17:08, new modules 20:14–20:16, `activity.ts` untouched since 09-07 10:08.

**Test results (`npm test`, full suite): 207 pass / 4 fail / 211 total.** All 4 failures are in `test/test.ts` → `subagent discovery` suite and are caused by the staged deletion of `agents/*.md` (see C1). The 5 new unit-test files (38 tests) all pass in isolation.

**What was checked:** `index.ts` (full, 2489 lines), `kitty.ts`, `status.ts`, `subagent-done.ts` + `-pure.ts`, `agents.ts`, `launch.ts`, `cli/pi.ts`, `cli/claude.ts`, `store.ts`, `config.ts`, `format.ts`, `keep.ts`, `names.ts`, `paths.ts`, `widget.ts`, `notifications.ts`, `status-bridge.ts`, `activity.ts`, `session/*` (8 files), `tools/safe-bash.ts`, `plugin/hooks/on-stop.sh`, `config.json`, and the full `npm test` output. Areas found clean are listed at the bottom.

---

## Critical Bugs

### C1. Bundled agent definitions deleted from worktree — 4 failing tests, spawn of `worker`/`scout`/`researcher` broken
- **File:line:** `pi-extension/subagents/agents.ts:140-142` (`getBundledAgentsDir` → `join(getSubagentsDir(), "../../agents")` ⇒ `<repo>/agents/`); worktree `agents/` no longer exists (staged `D` for all three `.md` files). Failing tests at `test/test.ts:1265` (bundled non-interactive), `:1277` (worker spawn grant), `:1291` (scout/researcher no-spawn), `:1341` (`getToolExtensionPath("web_search")` — knock-on, see C1-note).
- **Description:** `loadAgentDefaults("worker")` / `discoverAgentDefinitions()` resolve the package tier from `<repo>/agents/`, which is gone. `loadAgentDefaults` returns `null` for all three bundled agents, so `subagent({agent:"worker"…})` now fails the allowlist gate ("not a known agent") and every nested-spawn default is gone.
- **Why it's a problem:** This is the extension's shipped default workforce. Any user without identical `~/.pi/agent/agents/` copies loses all spawns; the repo's own test suite is red (4 failures), masking regressions.
- **Suggested fix:** Either restore `agents/*.md` (unstage the deletion: `git restore --staged agents/ && git restore agents/`) or, if the move is intentional, point `getBundledAgentsDir()` at the new canonical location, ship the files there, and update the 4 tests. Decide one source of truth — right now code, tests, and disk disagree.
- **Note on the 4th failure:** `test/test.ts:1341` (`web_search` → `web-search/index.ts`) fails because `getToolExtensionPath` (`agents.ts:121-129`) requires the extension file to `existsSync` under `PI_CODING_AGENT_DIR/extensions/`, which the isolated test env doesn't populate. That test was passing before only if the dev machine had those extensions installed — it is environment-dependent, but it surfaced now alongside the deletions. Fix by stubbing the extension dir in the test or by making the mapping pure (no `existsSync`) with existence checked at launch time.

### C2. Orphaned kitty tab when launch fails after `createSurface`
- **File:line:** `pi-extension/subagents/index.ts:1019` (`createSurface`) vs `1027` (`seedSubagentSessionFile`), `1099`/`1246` (`sendLongCommand`), `1136+` (loadout/sandbox build).
- **Description:** `launchSubagent` opens the tab *first*, then awaits the shell-ready delay and runs fallible work (seed file I/O, `mkdirSync`, `writeFileSync` for task artifact/sysprompt, `sendLongCommand`). Any throw after line 1019 propagates to the `subagent` tool's `try/finally` (which only releases the name reservation) — the tab is never closed and no watcher/registry entry exists for it.
- **Why it's a problem:** Tab leak per failed spawn; user accumulates dead shells. Same shape in the resume path (`index.ts:2122` creates the surface, then builds commands/sends at `2188`).
- **Suggested fix:** Wrap the post-`createSurface` body in try/catch that `closeSurface(surface)` (best-effort, guarded by `isKittyAvailable`) on failure before rethrowing. Same for the resume branch.

### C3. `ask_question` signal file is written non-atomically but consumed with delete-on-malformed — questions can be lost forever
- **File:line:** write at `pi-extension/subagents/subagent-done.ts:352` (`writeFileSync(\`${sessionFile}.ask\`, …)`); consume at `pi-extension/subagents/index.ts:1341-1365` (`deliverPendingQuestion`: `readFileSync` + `JSON.parse` in try, `unlinkSync` in the `catch` for malformed).
- **Description:** The parent polls every 1s (`pollForExit` `onTick`). If the tick reads while the child's `writeFileSync` is partway flushed (short window, but real on loaded disks / large questions), `JSON.parse` throws and the handler **deletes the file** (`unlinkSync` in the malformed branch) and returns `false`. The question is gone; the child parks on `awaitingAnswer` forever.
- **Why it's a problem:** Silent loss of the exact signal the whole ask/wait UX depends on; child appears "stuck waiting", parent never woken.
- **Suggested fix:** Atomic write on the child side (tmp file + `renameSync`, same pattern as `activity.ts:writeSubagentActivityFile` and `registry.ts:registerName`), and on the consumer side `rename` the `.ask` to `.ask.consuming-<pid>` before reading so concurrent consumers can't double-read/double-delete.

### C4. Resume completion crashes on corrupt/unparseable session file — successful result replaced by "Resume error"
- **File:line:** `pi-extension/subagents/index.ts:2235` (`const allEntries = getNewEntries(sessionPath, entryCountBefore)`) inside the resume `.then()` continuation.
- **Description:** `getNewEntries` (`session/io.ts:35`) does a bare per-line `JSON.parse` with no error handling. A single malformed line in a large resumed transcript throws *inside the `.then()`*, routing to the `.catch()` which sends `Resume error: …` — even though the resumed run completed fine and `watchSubagent` already returned a good result.
- **Why it's a problem:** Corrupt-line (common: killed child mid-flush) turns successes into errors and discards the summary/stats that were already computed.
- **Suggested fix:** Wrap lines 2235+ in try/catch with fallback to `result.summary` (the `watchSubagent` value), or make `getNewEntries`/`readEntriesAfter` skip-and-tolerate malformed lines (log count). At minimum, mirror the launch path, which falls back to `Sub-agent exited…` text.

---

## Major Issues

### M1. `session_shutdown` aborts the process-global poll controller — one session's shutdown kills other sessions' watchers
- **File:line:** `pi-extension/subagents/index.ts:1583-1593` (`moduleAbort.abort()` on every `session_shutdown`); recovery at `1523` only installs a fresh controller on the *next* `session_start`.
- **Description:** `POLL_ABORT_KEY` (`Symbol.for("pi-subagents/poll-abort-controller")`) is process-global and shared by all sessions/watchers (`watchSubagent` joins it at `1396`, `monitorKeptTab` at `577`). Closing session A aborts in-flight `pollForExit` loops of session B; B's watchers take the `signal.aborted` path and report "Subagent cancelled."
- **Why it's a problem:** Multi-session pi processes (explicitly supported — see the comment at `1519`) get cross-talk cancellations on any single session close.
- **Suggested fix:** Scope abort to the shutting-down session (track per-session `AbortController`s, or join watcher signal + a per-session controller instead of the module-global). Keep the module-global abort only for `/reload` (module invalidation), not `session_shutdown`.

### M2. Explicit-name collisions are not deduplicated — second spawn silently steals the registry handle, steer hits an arbitrary run
- **File:line:** `pi-extension/subagents/index.ts:1713-1714` (uniqueness + reservation only when `!params.name?.trim()`); steer-by-name at `2018` uses `Array.find` (first match).
- **Description:** Two parallel `subagent({name:"X",…})` calls with the same explicit name both launch; the second `registerName` overwrites the first's handle, and later `subagent_message({name:"X"})` steers whichever `find` returns first. `resolveRunningByName` (`785`) *does* have an ambiguity error, but the `subagent_message` running-branch doesn't use it.
- **Why it's a problem:** Lost resume handle for the first run; messages delivered to the wrong agent with an "ok" acknowledgement.
- **Suggested fix:** Apply `uniqueRunningName` (or reject with a clear error) to explicit names too, and route the `2018` running-branch through `resolveRunningByName` so ambiguity surfaces instead of steering at random.

### M3. `readEntries` / `getNewEntries` / `readEntriesAfter` throw on the first malformed line
- **File:line:** `pi-extension/subagents/session/io.ts:12`, `:35`, `:50` (bare `JSON.parse` per line); also `session/legacy-branch.ts:17`, `session/index-cache.ts:38` (already guarded there).
- **Description:** Crash-torn session files (killed child mid-append is the norm, not the exception) make result extraction (`index.ts:1447`), stats, and resume continuation throw. `summarizeSessionStats` catches (returns `null`), but the summary path does not — inconsistent.
- **Why it's a problem:** One torn line converts a clean exit into `Subagent error: …` (via `watchSubagent`'s catch) or M4/C4 above.
- **Suggested fix:** Single tolerant parser in `io.ts`: skip blank + malformed lines (optionally count them), used by all three readers. Keep a strict variant only for tests that need it.

### M4. Question delivery can double-fire under concurrent consumers (no atomic consume)
- **File:line:** `pi-extension/subagents/index.ts:1336-1380` (`existsSync` → `readFileSync` → `notify` → `unlinkSync`); concurrent readers: 1s `pollForExit` tick (`1402`), `monitorKeptTab` 2s tick (`583`), `recoverPendingQuestions` on `session_start` (`1332`).
- **Description:** Check-then-act with no mutual exclusion: two ticks can both pass `existsSync` before either `unlinkSync`s, delivering the same question twice as two `subagent_question` steers.
- **Why it's a problem:** Duplicate orchestrator wake-ups; user answers twice or steers twice.
- **Suggested fix:** Atomic claim via `renameSync(askFile, askFile + ".consuming-<pid>-<rand>")` before read (same approach as suggested in C3); on `ENOENT`, another consumer won — return.

### M5. `parseStatusConfig` makes `lineLimit` unconfigurable — and `config.ts` then silently swallows the resulting error
- **File:line:** `pi-extension/subagents/status.ts:139-150` (`rejectUnsupportedKeys(status, ["enabled"]…)` + hard `lineLimit: DEFAULT_STATUS_LINE_LIMIT`); `pi-extension/subagents/config.ts:16-27` (catch-all → defaults).
- **Description:** Any `config.json` containing `status.lineLimit` throws `Invalid subagent status config … unsupported key(s): lineLimit`. At runtime this is caught by `getExtensionConfig` and replaced with defaults — so the user's entire status/tabs config is silently discarded, not just the one key. Meanwhile every consumer reads `status.lineLimit` as if it were live config.
- **Why it's a problem:** Silent total-config fallback on a single innocent key; `lineLimit` can never actually be tuned despite being plumbed everywhere (`formatStatusAggregate`, `startStatusRefresh`).
- **Suggested fix:** Accept and validate `lineLimit` in `parseStatusConfig` (positive int, default 4), and narrow `config.ts`'s catch to `ENOENT`-only so invalid JSON / schema errors surface instead of silently defaulting.

### M6. Canonical launch builders are dead code — `index.ts` still builds both commands inline (drift already visible)
- **File:line:** `pi-extension/subagents/cli/pi.ts` (`buildPiLaunchCommand`, `buildPiResumeCommand`), `pi-extension/subagents/launch.ts:229` (`buildClaudeParts`) vs live inline builders at `index.ts:1067-1126` (claude), `1132-1253` (pi launch), `2122-2196` (resume). Only `copyClaudeSession` is actually imported (`index.ts:70`).
- **Description:** The "single home" refactor was left half-landed: the supposed canonical builders are unreferenced, and they have already drifted from the live paths (different script-preamble formats — ad-hoc 3-liner at `index.ts:1101-1105` vs `scriptPreambleFor`; resume uses hand-rolled `resumeEnvParts` at `2157-2176` instead of `buildEnvPrefix`, with subtly different key order/`PI_SUBAGENT_SURFACE` handling).
- **Why it's a problem:** Two truths for the security-sensitive command shape (sandbox flags, env encoding); future edits will land in one and miss the other.
- **Suggested fix:** Either finish the migration (route launch + resume through `cli/pi.ts`, claude through `cli/claude.ts`, delete inline duplicates, add snapshot tests pinning the exact command) or delete the dead builders. Also see M7 — the dead builders have their own bugs, so don't wire them in as-is.

### M7. Dead builders drop the script preamble (`void preamble` / `void scriptPreambleFor`)
- **File:line:** `pi-extension/subagents/cli/pi.ts:94-100` (computes `preamble`, then `void preamble;` and returns without it); `cli/pi.ts:151` (`void scriptPreambleFor;` — resume path never builds a preamble); `launch.ts:234` (`void dir;` — `buildClaudeParts` ignores the plugin dir entirely, unlike the live claude path at `index.ts:1075-1079`).
- **Description:** Anyone adopting these builders (per their docstrings: "shared by launch and resume") silently loses the provenance header in persisted launch scripts and, for claude, the `--plugin-dir` wiring.
- **Why it's a problem:** Debug scripts lose session/surface attribution; claude launches via the builder would lack the Stop-hook plugin (no sentinel → `pollForExit` falls to the slow screen-scrape path only).
- **Suggested fix:** Return/include the preamble in the builder result (or accept a `writeScript` helper that takes it), and thread `pluginDir` through `buildClaudeParts`. Add a test asserting preamble presence.

### M8. `shouldAutoExitOnAgentEnd` ignores its takeover parameter — signature lies about the policy
- **File:line:** `pi-extension/subagents/subagent-done-pure.ts:24-40` (`_userTookOver` unused; decision is purely last-assistant-`stopReason !== "aborted"`).
- **Description:** The name, call site (`subagent-done.ts`), and tests imply user-takeover influences auto-exit; it does not. Currently benign (takeover is tracked but only used… nowhere for the exit decision), but any future reader will mis-reason about kept-tab/manual-input behavior.
- **Why it's a problem:** Misleading contract in the exact file that decides whether a child kills its own session.
- **Suggested fix:** Remove the parameter (and update call sites/tests) or implement the intended policy explicitly with a comment. Ditto the now-stale `userTookOver` reset dance in `subagent-done.ts` (`if (autoExit) userTookOver = false`).

### M9. `safe_bash` is effectively unenforced for the default baseline + has trivial bypasses and a frozen cwd
- **File:line:** `pi-extension/subagents/tools/safe-bash.ts:42` (`createBashTool(process.cwd())` at load); `agents.ts:109-131` (`getToolExtensionPath`: builtins incl. `bash` → `undefined`, so allowlisted `bash` loads pi's native tool, never `safe_bash`); patterns at `safe-bash.ts:12-30`.
- **Description:** (a) The default tool baseline grants `bash`, which resolves to the built-in — `safe_bash` only loads if an agent literally lists `safe_bash`. The "Blocks dangerous commands" claim doesn't cover the standard worker. (b) Patterns are regex-fragile: `rm -rf -- /`, `rm -rf /tmp/../`, `$(rm -rf /)`, `` `reboot` ``, `env sudo …`, `python3 -c 'import shutil; …'` all slide past. (c) `process.cwd()` is captured once at extension load, not per invocation — relocated sessions get the wrong root.
- **Why it's a problem:** Security boundary that reads as enforced but isn't (for the common case), inviting false confidence.
- **Suggested fix:** Decide the real story: if `safe_bash` should wrap the baseline, map `bash→safe_bash` extension loading explicitly and document it; harden patterns (parse with a shell tokenizer rather than regex, block `--` end-of-flags, command substitution of blocked verbs); resolve cwd per-call from the tool context.

### M10. `on-stop.sh` hard-requires `python3`, risks unset-variable crash under `set -u`, and trusts transcript shape
- **File:line:** `pi-extension/subagents/plugin/hooks/on-stop.sh` (whole file; key lines: `set -euo pipefail`, `python3 -c` ×3, `[ "$user_msg_count" -eq 1 ]`).
- **Description:** (a) No `command -v python3` guard — on minimal images the transcript-count heredoc fails; under `set -e`/`pipefail` the hook exits non-zero, which Claude surfaces as a hook failure. (b) If that python fails, `user_msg_count` is empty and `[ "" -eq 1 ]` errors under `set -u`-adjacent strictness (actually `set -u` doesn't cover empty vars in `[ ]`, but `set -e` still aborts on the non-zero test… in an `if` it wouldn't; here it's a bare `[ ]` statement — aborts the script). (c) "Exactly 1 string-content user message ⇒ autonomous" assumes Claude's transcript schema; array-content human messages with attachments would miscount and either leak the sentinel (never fires → slow-path only) or fire early.
- **Why it's a problem:** Silent completion-detection failure on systems without python3; brittle autonomy heuristic.
- **Suggested fix:** Pure-bash/jq fallback (or `node -e`, guaranteed present since pi runs on node), default `user_msg_count` to a safe value on parse failure, and count array-content user messages whose blocks aren't all `tool_result`.

---

## Minor Issues / Nits

- **N1. Frozen `SUBAGENT_ALLOWLIST` const at import time** — `index.ts:237` snapshots `getSubagentAllowlistCanonical()` once; the live `subagent` gate correctly uses `getSubagentAllowlistFresh()` (`1645`), so the const is dead weight that will mislead the next editor into using it. Delete it. (Same class: `extensionConfig`/`statusConfig`/`tabsConfig` lets at `~460` are only refreshed on `session_start`; mid-session `/reload`-less config edits are half-live. Acceptable, but the comment should say so.)
- **N2. `hasCommand` caches forever + interpolates into `sh -c`** — `kitty.ts:30-48`. Only ever called with `"kitty"`, so the injection is latent, but a generic helper should use `execFileSync("sh", ["-c", "command -v -- \"$1\"", …])` or avoid the shell; and a TTL/recheck on `isKittyAvailable()===false` would let users install kitty without restarting pi.
- **N3. `windowExists` failure mode is indistinguishable from "tab gone"** — `kitty.ts:183-216`: any `kitty @ ls` failure (socket hiccup, corrupt JSON at `:195`) returns `false`, so `sendCommand` throws "may have been closed" for a live tab. Consider returning `null`/throwing distinctly on control-plane errors so steer can retry instead of reporting death.
- **N4. `sendCommand` TOCTOU + double round-trip** — `kitty.ts:246-258` does `windowExists` (a full `ls`) then two `kittenSync` calls. The tab can die between check and send (kitty send to a dead id silently succeeds), so the guard is advisory while doubling control traffic. Fine as defense-in-depth, but don't present it as a guarantee; the comment already half-admits this.
- **N5. Poison `.exit` sidecar is never removed when JSON is corrupt** — `kitty.ts:346-360`: if `JSON.parse(readFileSync(exitFile))` throws, the `rmSync` is skipped and the file is retried every poll tick forever (each tick also skips the `.done` check only after — actually the `.done` check still runs, so impact is a hot error loop + a stuck error signal). Move `rmSync` before parse, or rename-then-parse.
- **N6. Slow-path failure inserts a full-interval delay before serving a ready sidecar** — `kitty.ts:404-418`: when `readScreenAsync` throws (tab closed at exactly the right moment), the code re-checks the sidecar (good) but then still sleeps `options.interval` (1–2s) before looping. Trivial latency on the completion hot path; check-then-sleep ordering could return immediately when a sidecar was found… it does return; the nit is only the sleep when the sidecar *wasn't* there but the screen read failed — acceptable, noting for completeness.
- **N7. Claude fallback reads the screen synchronously on the event loop** — `index.ts:~1419` (`readScreen(surface, 200)` inside `watchSubagent` after an async poll). `readScreen` is `execFileSync`-based; a 200-line scrape blocks the extension host. Use `readScreenAsync`.
- **N8. Claude sentinel files leak on abort + are predictable in `/tmp`** — `index.ts:1068` (`/tmp/pi-claude-${id}-done`, 8-hex-char `id`). The abort path in `watchSubagent`'s catch never unlinks sentinel/`.transcript`. Predictable temp names are a symlink-squatting vector on multi-user boxes. Use `mkdtemp`-style unique dir or at least `O_EXCL` creation, and clean up in all paths (or centralize via `cleanupClaudeSentinel` in `cli/claude.ts`, which exists but is never called from `index.ts`).
- **N9. Kept-tab monitor reports `elapsed ~0s`** — `index.ts:583` builds the question carrier with `startTime: Date.now()` on every tick, so `notifyQuestion`'s elapsed is always "0s". Thread the original run's `startTime` (or the kept-track timestamp) through `KeptTab`.
- **N10. Leftover dead code in `status-bridge.ts`** — the `const { readSubagentActivityFile: read } = { readSubagentActivityFile }; void read;` dance. Remove.
- **N11. Duplicated tool-baseline consts** — `SUBAGENT_CONTROL_TOOLS`/`DEFAULT_SUBAGENT_TOOLS` exist in both `launch.ts:241-242` and `index.ts` (thin wrappers). Harmless, but the "canonical in launch.ts" comment should be enforced by deleting the index copies.
- **N12. `getFrontmatterValue` interpolates `key` into `RegExp`** — `agents.ts:144`. All call sites use constant keys, so not exploitable today; anchor/escape anyway (`key.replace(/[.*+?^${}()|[\]\\]/g, …)`) since it's a public export.
- **N13. `parseAgentDefinition` frontmatter regex is fragile** — `agents.ts:194` (`/^---\n([\s\S]*?)\n---/`): CRLF files, trailing-space fences, or `---` inside the body/frontmatter values break parsing silently (returns agent with wrong fields or `null` → skipped). Tolerate `\r?\n` and require the closing fence at line start.
- **N14. `formatElapsed` doesn't handle negatives/NaN** — `format.ts:26-31`: clock skew (`elapsed` from `Date.now()-startTime`) can print `-3s`. Clamp at 0; same for `formatElapsedMMSS`/`formatElapsedDuration` (the latter already clamps, the former two don't).
- **N15. `borderTop` uses UTF-16 length, not visible width** — `widget.ts:62-72`: `titlePart.length` miscounts wide/CJK chars, misaligning the widget border for such names. Use `visibleWidth` (already imported) for `fillLen`.
- **N16. `CLAUDE_SESSIONS_DIR` uses `process.env.HOME` with `/tmp` fallback** — `cli/claude.ts:10-14`. Prefer `os.homedir()` for consistency with `agents.ts:getAgentConfigDir`.
- **N17. `registerName`/`readNameRegistry` swallow all errors** — `session/registry.ts:36-66`. Disk-full or permission errors silently lose resume handles. At minimum log once (via `console.error`, the extension host surfaces it) instead of pure swallow.
- **N18. `AbortSignal.any` availability** — `index.ts:577,1396` requires Node ≥ 20.3. No `engines` field in `package.json` to enforce it. Add `"engines": {"node": ">=20.3"}` or a tiny polyfill.
- **N19. Activity recorder timers aren't `unref`'d** — `activity.ts:scheduleFlush` holds a 500ms `setTimeout`; in the child this can delay process exit by up to a throttle window after `markDone`… actually `markDone`/`disable` clear it, and `sessionShutdown→disable` clears too, so impact is negligible — noted only so nobody "fixes" it into a leak.
- **N20. `config.json` (repo root, gitignored? no — tracked?) ships `tabs.keepOpen: true`** while `config.json.example` ships `false`. If `config.json` is user-local it should be gitignored to avoid committing personal prefs; if it's the default it should match the example. Verify intent — right now a fresh clone behaves differently from what the example documents.

---

## Areas checked and found clean

- **Shell quoting:** all command assembly goes through `shellEscape` (`kitty.ts:250-252`); `matchFor` restricts kitty `--match` to numeric `id:` (`kitty.ts:143-149`), so no match-syntax smuggling. Env values, session paths, `@file` args all quoted at every call site inspected.
- **Legacy `PI_SUBAGENT_KEEP_TAB` removal:** scrubbed at launch (`index.ts:1240`, resume `2183`), deleted on import in both parent and child (`index.ts:~376`, `subagent-done.ts`), never consulted. Consistent.
- **Keep/exit truth table:** `keep.ts` + all call sites agree (`keep ⇔ keepOpen && !autoExit`); resume forces autonomous (`resolveResumeLaunchBehavior`, `resolveResumeKeepDecision`). No contradictions found.
- **Kept-tab double-open guard:** resume refuses when the kept surface is alive (`index.ts:~2060-2095`), prunes dead entries via `store.findKept` + `clearKeptSurface`, and `session_start` rebuilds monitors. Logic is sound (modulo M1/N9).
- **`ask_question` lifecycle flags:** `awaitingAnswer` set on ask, cleared on both `input` (mid-run steer absorption) and `agent_start` (fresh turn) — the subtle no-new-`agent_start` case is handled and commented. `hasPendingChildren` gate via the process-global count is coherent.
- **Registry atomicity:** temp-file + `renameSync` writes (`registry.ts:52-58`); corrupt-registry reads degrade to `{}` rather than crashing.
- **Session index cache:** stat/mtime-validated incremental index (`index-cache.ts`); first-line-only header reads; async variant yields to the loop. No full-tree parse on the hot path.
- **Activity file validation:** strict schema gate (`activity.ts:validateActivity` — version, enums, finite numbers, newline/length caps, `wrong-id` vs `invalid` distinction). Throttled writes with failure cap.
- **Status state machine:** `observeStatus`/`classifyStatus`/`advanceStatusState` are well-tested (19 status tests pass); stale-snapshot and interrupt-override handling is careful and commented.
- **Notifications envelope:** single owner (`notifications.ts`), all five helpers emit the same `sendMessage(…, {triggerTurn:true, deliverAs:"steer"})` shape; `resolveResultPresentation` covers ok/fail/error distinctly.
- **`/reload` survival:** widget/status intervals cleared + module abort controller rotated at import (`index.ts:126-150`); tool-extension registry is reload-idempotent (`agents.ts:registerToolExtension`).
- **No blocking on the parallel refactor:** all findings above are against code as read; nothing in this review waited on or assumed refactor outcomes. The refactor's *direction* (canonical modules) is good — M6/M7 just note it is half-landed.
