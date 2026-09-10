# Task: Bug Mediums + lifecycle — trust boundaries and watcher robustness

**Filename**: `tasks/2026-09-09-bug-mediums-lifecycle.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-bug-mediums-lifecycle_summary.md`.

---

## Context

- Medium-severity correctness bugs + the two lifecycle Highs from `bug-findings.md`, all confirmed in `bug-findings-review.md`. They share one theme: the parent trusts state it didn't validate (config, loadout, registry, claims) and owns session lifecycle globally instead of per-session.
- Covers: M4 (tabs-only config throws in render/timer paths), M5 (resume trusts `.loadout.json`; `toolAllowlist: null` → unrestricted), M6 (corrupt registry clobbered), M2 (claim-restore clobbers newer `.ask` — land with compat-1 gate so the queue can't entomb a torn claim), M3 (cancelled runs still notify; notify-throw escapes), M7 (torn-line baseline skew), M8 (`Symbol.for`-backed tool map for `/reload`), M9 (kept second-`.done` ends supervision), H4 (per-session timers; `latestCtx`/`latestPi` last-writer-wins), H5 (reload orphans non-kept runs).
- Depends on: bug-highs task (same watcher/registry files — land after so collisions settle). Blocks: refactor handlers/lifecycle task (which moves this code into `handlers/` + `lifecycle.ts` and must preserve these fixes).
- Links: `bug-findings.md` (M2–M9, H4, H5, Compat 1–2), `bug-findings-review.md` (Confirmed §§, Recommended order #5–9, M5 teardown-test criterion), `AGENTS.md` rules 3–5.

---

## Task-Description

1. **Trust boundaries (M4/M5/M6/M8):** absent `status` section ⇒ defaults (mirror `parseTabsConfig` leniency; present-but-invalid still throws per rule 5); render + 1s timer paths use safe/cached config. Validate loadout on read (`toolAllowlist` must be non-empty string or refuse resume). Corrupt registry → back up to `*.corrupt-<ts>`, merge salvageable entries, never overwrite blind. Move `EXTRA_TOOL_EXTENSIONS` map onto a `Symbol.for` global.
2. **Watcher robustness (M2/M3/M7/M9):** no-clobber claim restore (restore Q1 only if `.ask` absent, else queue as `.pending-N` drained next tick; land the mixed-version retain-then-retry gate in the same change). Skip all notification when `result.error === "cancelled"` / signal aborted; wrap every `notify*` in try/catch. Baseline resume window with `readEntriesAfter(f,0).total` (same basis as the later slice). Kept monitor ignores second `.done` (watch `.exit`+`.ask` only after first result) or persists the fired flag.
3. **Lifecycle (H4/H5):** scope widget/status timers per spawner session (map keyed by artifact dir / refcount; shutdown tears down only that session's timers; widget routes to owning ctx). Persist `surface` for running runs at launch and re-`watchSubagent` on `session_start` (with stale-sidecar hygiene), or emit a loud `subagent_status` orphan steer if intentionally limited — never leave a live tab ownerless silently.
4. Tests per report table: M4 tabs-only config, M5 loadout rejection, M6 backup, M2 newer-preserved, M3 no-send-on-abort, M7 torn-baseline, M8 reload survival, M9 second-done ignored, H4 survivor-timers, H5 resurrection.

---

## Files to Touch

- **Trust:** `pi-extension/subagents/status.ts` (parse leniency), `pi-extension/subagents/config.ts` (safe access), `pi-extension/subagents/session/loadout.ts` (validation), `pi-extension/subagents/session/registry.ts` (backup+merge), `pi-extension/subagents/agents.ts` (tool-map global).
- **Watchers/lifecycle:** `pi-extension/subagents/index.ts` (`deliverPendingQuestion`, `watchSubagent` abort branch + `.then` handlers incl. resume `.catch` at ~2397 → route via `notifyErrorCanonical` per Missing M1, `session_start` recovery, `session_shutdown` teardown), `pi-extension/subagents/kitty.ts` (sidecar policy), `pi-extension/subagents/notifications.ts` (if envelope needed).
- **Tests:** `test/bugfixes.test.ts`, `test/session-status-split.test.ts`.

---

## Acceptance Criteria

- [ ] Tabs-only config loads with status defaults; widget render + status tick degrade to last-good instead of throwing per frame.
- [ ] Resume with `toolAllowlist: null`/wrong-shaped loadout is refused (never unrestricted); child-rewritten sidecar cannot escalate.
- [ ] Corrupt registry is backed up and salvageable entries survive the next `registerName`.
- [ ] Failed Q1 delivery with newer `.ask` present preserves Q2 (queue, no overwrite); torn-claim policy version-gated.
- [ ] Aborted `watchSubagent` produces zero `sendMessage` calls; throwing `sendMessage` never rejects (incl. resume `.catch` via `notifyErrorCanonical`).
- [ ] Torn lines before resume point don't shift the new-entries window; tool registrations survive re-import; kept monitor survives second `.done` while tab lives.
- [ ] Two `session_start`s + one `session_shutdown` leaves survivor timers alive on owning ctx; reload re-watches running runs (or loud orphan steer).
- [ ] `npm test` green; no `__test__` key removal; registry/sidecar formats unchanged.

---

## Notes

- M10/M11 severity → Low per review; they ride the refactor/hygiene task, not here.
- `Symbol.for` key literals are compat surface — keep exact strings; the hygiene task pins them with a test.
- Keep `rejectUnsupportedKeys` loud for wrong *types*; only unknown *keys* (Compat 5) become warn-and-ignore, in the hygiene task.
