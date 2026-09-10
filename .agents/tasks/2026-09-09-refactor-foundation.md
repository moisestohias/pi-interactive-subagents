# Task: Refactor foundation — wrappers, constants, renderers (Phases 1 + 1.5)

**Filename**: `tasks/2026-09-09-refactor-foundation.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-refactor-foundation_summary.md`.

---

## Context

- Completes the R1–R11 migration: `index.ts` (~2629 lines) still carries ~40 delegating wrappers (`index.ts:233–830`) plus inline renderers that invert notification strings by regex surgery. Review endorses T1/T6/P3 with corrections: 6 wrappers are adapters with real logic (not pure aliases), and the renderer coupling is a silent-breakage hazard (raise priority).
- Depends on: Phase-0 snapshots exist; bug-highs landed (same file, earlier collisions settled). Blocks: launch-unification task (which builds on clean imports).
- Links: `refactor-suggestions.md` (T1, T6, P3, S1/S2/S5/S9/S11/S12), `refactor-suggestions-review.md` (T1 with 6-adapter correction + clean-name guidance, T6 raise-priority, S5/S11/S12 easier-than-stated, M3 `__test__` rule).

---

## Task-Description

1. **T1a pure-alias deletion (~30 wrappers):** re-point internal call sites at canonical imports under **clean names** (`import { buildEnvPrefix } from "./launch.ts"`, not `*Canonical` propagation — the suffix is migration scar tissue), delete wrappers, re-point `__test__` (`index.ts:952–999`) at canonicals directly (no test changes; `test/test.ts` imports only via `__test__`). Delete dead triple cache (`extensionConfig/statusConfig/tabsConfig` + `safeConfigInit`, keep the invalid-config startup warning + `invalidateExtensionConfigCache()` in `session_start`), dup `ICON_*`/`ACCENT`/`RST` (import from `widget.ts`), `void …CANONICAL` aliases (S12).
2. **T1b adapter relocation (6 with logic):** move with logic + comments: `renderSubagentWidgetLines` (RunningSubagent→WidgetRow map + `status.enabled` inject), `buildSubagentToolAllowlist` (`spawningTools` default), `formatWidgetRightLabel` (keep 2nd `opts` — don't silently drop the claude label), `shouldKeepSurface*` (fresh-config reads; keep behavior), `maybeCloseSurface` (make `keepSurface` **required** — zero legacy callers), `keptTabAlive` (fold N3 default into `store.ts:findKept`, delete wrapper). Preserve type-shim casts deliberately.
3. **T6+P3 renderers:** add `summary` to `notifyResult` details (one line in `notifications.ts`), switch `subagent_result` renderer to `details.summary` with stripping-fallback for old persisted messages, move all three message renderers + six `renderCall`/`renderResult` closures to new `renderers.ts` (depends only on notifications/format/widget). Fold S9 in: reuse `escapeRegExp` only in the fallback (then delete the dynamic-`RegExp` once fallback retires). S11: replace the inline `resolve()===resolve()` loop with `subagentStore.findRunningBySessionFile`.

---

## Files to Touch

- **From:** `pi-extension/subagents/index.ts` (wrappers ~233–830, `__test__` ~952–999, renderers ~2440–2629, `session_start` refresh).
- **To / shared:** `pi-extension/subagents/renderers.ts` (new), `pi-extension/subagents/notifications.ts` (summary field), `pi-extension/subagents/store.ts` (kept-default), `pi-extension/subagents/widget.ts` (constants source), `pi-extension/subagents/config.ts` (cache invalidation).
- **Tests:** none new required; existing suites guard (add 2–3 renderer assertions only if gaps).

---

## Acceptance Criteria

- [ ] `index.ts` −400 lines approx; no local `function` shadows a home-module export; `__test__` keys intact (re-pointed only).
- [ ] `keepSurface` param required; all three `maybeCloseSurface` callers pass explicitly; `keptTabAlive` wrapper gone.
- [ ] Renderers render from `details.summary` (fallback only for old messages); `renderers.ts` imports nothing from store/kitty.
- [ ] New suites import homes directly (M3 rule — no new `__test__` keys); `npm test` green.

---

## Notes

- Zero behavior change. Byte-identical renderer output (pin with existing `test/test.ts` assertions before moving).
- Do not touch builders/commands here (next task owns them); do not split `status.ts`/`activity.ts`/`kitty.ts` (deferred lazy).
