# Subagent task delivery without touching Pi core

Emulating `@raw` and `@file --no-wrap` from the extension alone.

> Scope: no Pi core changes. This doc builds on `file-wrapper-artifacts.md`.

## What `file-wrapper-artifacts.md` already established

- Pi core 0.84.1 always expands CLI `@file` args into `<file name="...">content</file>` text.
  - Done in `dist/cli/file-processor.js:processFileArguments()`.
  - Called from `dist/main.js:prepareInitialMessage()`.
  - Prompt order is `stdin → file block(s) → messages[0]` (`dist/cli/initial-message.js:buildInitialMessage()`).
- Expansion happens once, at process startup.
  - Typing `@path` into a live kitty TUI tab never expands it.
- Any workaround must follow these rules:
  - Keep the outer `@artifact` wrapper.
  - Transform only parent-originated blocks, in `launch.ts`.
  - Wire thinly in `lifecycle.ts` and `handlers/message.ts`.
  - Pre-filter re-attached paths with `existsSync + statSync.size > 0`.
  - Dedupe and cap at `MAX_EMBEDDED_FILES_PER_TASK = 10`.
  - Resolve relative `<file name>` values against parent `ctx.cwd`.
  - Keep `buildPiPromptArgs` byte-identical when the new parameter is absent.
  - Never shell out to `kitty @` outside `kitty.ts`.
  - Quote only via `shellEscape`.
  - Add regression tests in `test/bugfixes.test.ts` via direct home imports (never new `__test__` keys).

- This doc proposes two extension-only workarounds.
  - They emulate the requested core features without forking or patching Pi core.
- It also has a short appendix showing what an upstream core change would look like.
  - Purpose: make clear the extension never needs a private core fork.

## Understanding the current mechanism

- Launch path:
  `lifecycle.ts` builds `fullTask` (roleBlock + modeHint + params.task + summaryInstruction)
  → `launch.ts:writeTaskArtifact(artifactDir, name, fullTask)`
  → `@artifactPath`
  → `buildPiLaunchPlan()` → `buildPiParts()`
  → `pi --session <sessionFile> -e subagent-done.ts [--model …] [--system-prompt|--append-system-prompt <syspromptFile>] [--no-extensions --tools …] [@artifact]`
- Result: the child always sees exactly one outer `<file name=".../context/w-<ts>.md">` wrapper around the assembled prompt.
- Any parent-originated `<file>` blocks the parent LLM copied into `params.task` appear as stale nested snapshots inside that wrapper.
- This is expected core behavior, not a defect.
  - The one exception is the spawning case where we want the child to receive live file content, not a frozen copy.

- The two requested core ideas:
  - (a) A new `@`-like CLI syntax that injects file content raw, with no `<file>` XML wrapper, used only for subagent launch.
  - (b) A flag on the existing `@file` mechanism (e.g. `@file --no-wrap` or `--file-mode=raw`) that suppresses the XML wrapper.
- Both would require editing Pi core:
  - `dist/cli/args.js:parseArgs()` — a new producer branch beside `arg.startsWith("@") → fileArgs.push(arg.slice(1))`.
  - `dist/cli/file-processor.js:processFileArguments()` — conditional emit of `` `<file name="${absolutePath}">\n${content}\n</file>\n` `` vs raw `content`.
  - `dist/cli/initial-message.js:buildInitialMessage()` — unchanged ordering, only the `fileText` payload changes shape.
  - `dist/main.js:prepareInitialMessage()` plus the `--mode rpc` hard-error guard.
- That is exactly the fork-drift burden we avoid by staying extension-only.

## Proposal 1 — emulate a launch-only `@raw` using channels Pi core already injects raw

Recommended. No core change.

### 1A — env var plus child-side `read` (preferred)

Smallest and most explicit option.

- Keep `@artifact` delivery exactly as-is for compatibility.
- Add an opt-in, launch-only raw side-channel via environment + the child's `read` tool.
- Extend `buildPiLaunchPlan()` with an optional `rawTaskFile?: string` parameter.
- Only when present, write the same `fullTask` (or the unwrapped parent-extracted portion) to a second artifact file.
- Export its absolute path as `PI_SUBAGENT_TASK_FILE=<absPath>` in the single-order `buildEnvPrefix()` output.
- In `lifecycle.ts`, append one sentence to `fullTask`:
  `Your full task text is also on disk at $PI_SUBAGENT_TASK_FILE; if the <file> wrapper looks truncated or stale, read that path with the read tool as the source of truth`
- Benefits:
  - The child gets byte-identical raw content.
  - Zero XML wrapper.
  - Zero `ARG_MAX` risk.
  - Zero stdin-terminal conflict.
  - Zero core edit.
- Cost: one extra child `read` call, paid only by opt-in agents.
- Guard: the flag requires `read` in the child's effective tool allowlist.
  - `buildSubagentToolAllowlist` keeps baseline `read` unless a custom agent `tools` list drops it, which is exactly the hole.
  - So launch must check the resolved allowlist when the flag is on: if `read` is absent, either force-add it or fall back to artifact-only and warn.
  - Never launch a child whose pointer sentence names a file it has no tool to open.
- Contract and persistence: document `PI_SUBAGENT_TASK_FILE` as a new row in the M4 env-prefix contract in the `buildEnvPrefix` header comment (writer → reader → compat, same as `PI_SUBAGENT_SESSION/ID/ACTIVITY_FILE`), snapshot the raw-task file path in `SubagentLoadout` (`session/loadout.ts`) so `subagent_message` resume replays the same pointer instead of losing it, and teach `sweepStaleArtifacts` (`lifecycle.ts`) that the second artifact file is kept (same grace as live sidecars), never swept while its run is live.

### 1B — reuse the raw system-prompt channel (zero extra read)

- Reuse the existing `applySandboxToParts()` system-prompt file path (`--append-system-prompt <file>`).
- Pi core injects that as raw prompt text, with no `<file>` wrapper.
- Add an optional `rawTaskInSystemPrompt?: boolean` plan flag.
- When set, write `fullTask` to `context/<slug>-rawtask-<ts>.md`.
- Append it via `--append-system-prompt`.
- Reduce the `@artifact` user message to a one-line pointer.
- Caveat: the task lands in the system role, not the user role.
  - Acceptable for instruction-style subagent prompts.
  - Role-sensitive agents should prefer 1A.
- Strict constraint: with the flag absent, `buildPiParts()` output must stay byte-identical, so all existing command snapshots pass untouched.
- Interaction: `applySandboxToParts()` already chooses `--system-prompt` vs `--append-system-prompt` from `systemPromptMode` (`replace` vs append) for the agent identity file, so the raw-task file must always use `--append-system-prompt` (never `--system-prompt`) and be appended after the identity entry, preserving that existing flag choice and ordering instead of overriding it.
- Overhead note: reducing the `@artifact` user message to a one-line pointer still pays the outer wrapper around that pointer; the saving is staleness/truncation safety, not tokens.

### 1C — argv-direct delivery (already proven by fork mode)

- Generalize the existing `taskDelivery: "direct" | "artifact"` switch in `buildPiPromptArgs()`/`buildPiLaunchPlan()`.
- Today `direct` is used only for full-context fork mode (`lifecycle.ts:934-936`).
- Add a size-gated opt-in:
  - Use `direct` when `Buffer.byteLength(fullTask) < 64_000` and the task has no NUL bytes.
  - Otherwise fall back to `artifact` + the 1A pointer.
- Why: a direct positional message arg goes through no `processFileArguments()` expansion, so it carries zero wrapper.
- Cost: `ARG_MAX` and quoting pressure.
  - `shellEscape` already handles the quoting.
  - Still worth a byte cap and a snapshot test proving `artifact` output is unchanged when the flag is absent.

## Proposal 2 — emulate `@file --no-wrap` as an extension-level launch flag

Recommended API shape. No core flag. Single home in `launch.ts`.

- Add no CLI flag to Pi core.
- Instead add one optional launch-plan parameter to `buildPiLaunchPlan()`/`buildPiResumePlan()` in `pi-extension/subagents/launch.ts`:
  - `unwrapParentBlocks?: { cwd: string } | undefined`, or `rawFiles?: string[]`.
- `launch.ts` is the single home for the transform.
- Wire thinly only at the two existing call sites:
  - `lifecycle.ts` launch path.
  - `handlers/message.ts` resume path.
- Implementation:
  - Scan `params.task`/`opts.message` for `<file name="...">...</file>` blocks with an attribute-anchored, non-greedy match on the `name="..."` attribute (never a bare `.*` across the body), because file content itself may contain a literal `</file>` line.
  - Extract candidate paths from the `name` attribute only, never from body text.
  - Image upside: re-attaching also restores binary attachments.
    - Parent image blocks (`<file name="... avatar.png"></file>` plus attachment) arrive in `params.task` as empty wrappers since attachments do not survive the `task` tool-call copy, so re-attaching the live path is the only way the child gets the image back.
  - Resolve each relative path against the parent `ctx.cwd` and emit absolute paths.
  - Pre-filter with `existsSync(path) && statSync(path).size > 0`.
    - Core `processFileArguments` hard-exits on missing files and silently skips empty ones.
  - Dedupe repeats.
  - Cap at `MAX_EMBEDDED_FILES_PER_TASK = 10`.
  - Leave missing/empty/over-cap content inline, so no information is destroyed.
  - Append the surviving absolute paths as extra `@<path>` prompt args after the `@artifact` arg.
- Result:
  - The child gets live file content as first-class top-level `<file>` blocks.
  - The outer `@artifact` wrapper stays exactly as `file-wrapper-artifacts.md` constraint #1 requires.
- `buildPiPromptArgs` returns byte-identical output when the parameter is absent.
- New regression tests in `test/bugfixes.test.ts`:
  - missing-file filtering
  - empty-file filtering
  - dedupe
  - cap
  - relative-to-parent-cwd resolution
  - snapshot identity
  - parser edge: body containing a literal `</file>` line does not truncate or misattribute the path

### Explicit non-goals (from `file-wrapper-artifacts.md`)

Do not implement these, even though they resemble the requested core features:

- Regex-stripping `<file>` tags without re-attaching paths.
  - Destroys both content and path, while the outer wrapper is re-added anyway.
- Piping the task via stdin.
  - The child runs interactive in a kitty tab, so stdin is the terminal.
  - `stdinContent` only applies to print/rpc entry.
- Passing `@path` inside a steer message to a running tab.
  - No startup expansion occurs.
  - `flattenSteerMessage` collapses newlines into one giant line.
  - Steers must carry read-it-yourself instructions, never content.
- Applying the same trick to the `buildClaudeCommand` path.
  - No `@` mechanism exists there.
- Seeding the initial message into the session `.jsonl` via `session/seed.ts`.
  - Deepens the `version: 3` Compat-6 schema-tracking hazard, with no pi-version-pinned schema test.
- Switching `session-mode` to fork as a wrapper fix.
  - Fork still pastes parent blocks via direct delivery.

## Suggested rollout (extension-only, no Pi reinstall or core version pin bump)

### Step 1 — land Proposal 2 as a pure additive change

- Add the optional `unwrapParentBlocks` param and export `MAX_EMBEDDED_FILES_PER_TASK`.
- Add direct-import unit tests.
- Update docs in `docs/HOW-IT-WORKS.md` signals section only if a new suffix is introduced, which this proposal does not need.
- Verify with `node --test test/bugfixes.test.ts` plus one focused launch snapshot suite.
- Then `/reload` and retest, because extension changes only take effect on reload.
- Ignore the 4 pre-existing `subagent discovery` failures in `test/test.ts` per `AGENTS.md`, unless `agents.ts` discovery was touched.

### Step 2 — land Proposal 1A behind an opt-in

- Opt in via agent frontmatter or `config.json`, e.g. `raw_task_file: true`.
- Parse it alongside existing agent options in `agents.ts`.
- Always thread it through `SubagentLoadout` in `session/loadout.ts`, since resume must replay the same raw-task pointer.
- For a `config.json` key (as opposed to per-agent frontmatter), follow the config pipeline: parse/validate in `status.ts` (known keys strict on types, unknown keys warn-and-ignore), add the default plus example in `config.json.example`, and document it in the `docs/EXIT-KEEP-PRECEDENCE.md` config reference.
- Document it in `README.md` + `docs/AGENT-OPTIONS.md`.
- Default off, so every existing snapshot stays byte-identical.
- Keep the child instruction sentence to one line, so token overhead is negligible.

### Step 3 — optional, only if argv pressure proves fine in practice

- Enable Proposal 1C size-gated `direct` delivery for small tasks.
- Keep the 1A env pointer as the fallback for large tasks.
- Snapshot both branches.

## Appendix (informative only): an upstream Pi core change

Included only so reviewers can see why the extension does not need it.

### Core sketch A — new launch-only raw syntax

- In `dist/cli/args.js:parseArgs()`, add a sibling branch beside the existing `fileArgs` producer:
  - `arg.startsWith("@!") → result.rawFileArgs.push(arg.slice(2))`
- Thread `rawFileArgs` through `dist/main.js:prepareInitialMessage()` into a `processRawFileArguments()` sibling.
  - It mirrors the `access`/`stat`/image/text pipeline of `processFileArguments()`.
  - But it concatenates raw `content + "\n"`, with no `<file>` template and no image-attachment divergence.
- Join it in `dist/cli/initial-message.js:buildInitialMessage()`.
  - Order: `stdin → wrapped fileText → rawText → messages[0]`.
  - This preserves existing ordering guarantees.
- `--mode rpc` keeps its hard error for both kinds.

### Core sketch B — flag suppressing the wrapper

- Accept either:
  - a per-arg suffix, e.g. `@path:raw`, parsed in `parseArgs()` into `{ path, wrap: false }` entries; or
  - a global CLI switch, e.g. `--no-file-wrapper` / `--file-mode=wrapped|raw`, stored on `parsed` and passed as `options` into `processFileArguments(fileArgs, { autoResizeImages, wrap })`.
- Branch only at the four emission sites in `file-processor.js`:
  - `` `<file name="${absolutePath}">\n${content}\n</file>\n` `` vs raw `${content}\n`.
- Leave untouched:
  - path resolution
  - `~`/screenshot-space handling
  - missing-file `process.exit(1)`
  - empty-file skip
  - image attachment handling
  - prompt assembly
  - the rpc guard
- Caveat: suppressing the wrapper also suppresses the provenance (`name=`) the model uses to tell file content apart from typed instructions.
- That is exactly why the extension-level proposals are safer:
  - They keep the outer wrapper intact.
  - They add raw content through channels whose provenance is explicit, not silent: env + `read`, system-prompt file, direct argv, re-attached live `@path` args.
