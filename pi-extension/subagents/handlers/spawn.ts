/**
 * handlers/spawn.ts — `subagent` tool execute (T5, Phase 4b).
 *
 * Thin + effectful: pure gating lives in `validators.ts` (directly
 * unit-tested); orchestration (launch/watch/fan-out) lives in
 * `lifecycle.ts`. This file only translates validator failures into tool
 * results and threads `pi`/`ctx` through.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { validateSelfSpawn, validateSpawnParams, validateNameCwd } from "./validators.ts";
import {
  launchAndWatch,
  launchSubagent,
  muxUnavailableResult,
  reservedNames,
  shouldNotifyResult,
  subagentStore,
  trackKeptTab,
  uniqueRunningName,
  type RunningEntry,
  type SubagentResult,
} from "../lifecycle.ts";
import { getArtifactDir } from "../paths.ts";
import { getSessionId, readNameRegistry, registerName } from "../session.ts";
import {
  discoverAgentDefinitions,
  getSubagentAllowlist,
} from "../agents.ts";
import { notifyError, notifyResult } from "../notifications.ts";
import { isKittyAvailable } from "../kitty.ts";

export const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

export interface SpawnCtx {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

function fail(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export async function executeSpawn(
  pi: ExtensionAPI,
  params: typeof SubagentParams.static,
  ctx: SpawnCtx,
) {
  // Prevent self-spawning (e.g. planner spawning another planner)
  const self = validateSelfSpawn(params.agent, process.env.PI_SUBAGENT_AGENT);
  if (!self.ok) return fail(self.text, self.details);

  // Strict whitelist at every depth (pure gate in validators.ts).
  const freshAllowlist = getSubagentAllowlist();
  const gate = validateSpawnParams(params, {
    allowlisted: freshAllowlist,
    discoverable: discoverAgentDefinitions().map((a) => a.name),
  });
  if (!gate.ok) return fail(gate.text, gate.details);

  // C1: tool-boundary control-character rejection (sink re-validates too).
  const clean = validateNameCwd(params);
  if (!clean.ok) return fail(clean.text, clean.details);

  // Validate prerequisites (need mux + a session file to derive the
  // artifact dir that hosts this session's name registry).
  if (!isKittyAvailable()) {
    return muxUnavailableResult();
  }

  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [
        {
          type: "text",
          text: "Error: no session file. Start pi with a persistent session to use subagents.",
        },
      ],
      details: { error: "no session file" },
    };
  }

  // This spawner session's artifact dir hosts its persistent name
  // registry (artifacts/<parentSessionId>/subagent-registry.json).
  const parentArtifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );

  // M2: names are unique per spawner session (running or finished).
  // Defaulted AND explicit names both go through uniqueRunningName against
  // running + reserved + registry, reserved synchronously (before any
  // await) so parallel spawns can't collide and no spawn ever steals
  // another run's registry handle. An explicit "X" taken becomes "X-2".
  let reservedName: string | null = null;
  {
    const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
    const base = params.name?.trim() || params.agent;
    const unique = uniqueRunningName(base, registryNames);
    if (params.name?.trim() && unique !== params.name.trim()) {
      // Tell the caller about the rename via the acknowledgement details
      // (content stays stable; details carry requested vs assigned).
      (params as any).__requestedName = params.name.trim();
    }
    params.name = unique;
    reservedName = unique;
    reservedNames.add(reservedName);
  }

  // Launch + watch via the shared orchestration (lifecycle.ts). The
  // reservation is released once the run registers (or launch fails) —
  // from then on uniqueRunningName tracks it via the running map.
  const running = await launchAndWatch({
    start: async () => {
      try {
        return await launchSubagent(params, ctx);
      } finally {
        if (reservedName) reservedNames.delete(reservedName);
      }
    },
    afterStart: (r: RunningEntry) => {
      // Persist name → session so subagent_message({ name }) can resume this
      // subagent after it finishes (and after a pi restart). Done at launch,
      // not completion, so the handle exists even if the parent dies mid-run.
      // H5: persist the live `surface` too (marked `running`), so a
      // `/reload` that orphans this run can re-watch the still-live tab on
      // `session_start` instead of losing its result. The completion
      // handler re-registers without `running` (keeping `surface` only for
      // kept tabs), so the flag cannot go stale.
      registerName(parentArtifactDir, r.name, {
        sessionFile: r.sessionFile,
        sessionId: getSessionId(r.sessionFile),
        surface: r.surface,
        running: true,
      });
    },
    hooks: {
      onResult: (r: RunningEntry, result: SubagentResult) => {
        // Keep the registry truthful about kept tabs (feeds the resume
        // double-open guard); clears any stale surface otherwise.
        registerName(parentArtifactDir, r.name, {
          sessionFile: r.sessionFile,
          sessionId: result.sessionId ?? null,
          ...(result.surfaceKept ? { surface: r.surface } : {}),
        });

        // Kept tab outlives this watcher: keep relaying later
        // ask_question signals and allow steering into the live tab.
        // Without this, questions asked after manual follow-ups in the
        // kept tab sit orphaned until the next /reload recovery.
        if (result.surfaceKept) {
          trackKeptTab(
            subagentStore,
            parentArtifactDir,
            {
              name: r.name,
              agent: r.agent,
              surface: r.surface,
              sessionFile: r.sessionFile,
              sessionId: result.sessionId ?? null,
              startTime: r.startTime,
            },
            pi,
          );
        }

        if (shouldNotifyResult(result)) {
          try {
            notifyResult(pi as any, {
              name: r.name,
              task: r.task ?? "",
              agent: r.agent,
              summary: result.summary,
              sessionFile: result.sessionFile,
              sessionId: result.sessionId,
              claudeSessionId: result.claudeSessionId,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              errorMessage: result.errorMessage,
              stats: result.stats,
              surfaceKept: result.surfaceKept,
            });
          } catch {
            // Teardown races sendMessage — never reject unhandled.
          }
        }
      },
      onError: (r: RunningEntry, err: unknown) => {
        try {
          notifyError(pi as any, r.name, r.task ?? "", err);
        } catch {
          // Teardown races sendMessage — never reject unhandled.
        }
      },
    },
    pi,
  });

  // Return immediately
  return {
    content: [
      {
        type: "text",
        text:
          `Sub-agent "${params.name}" launched and is now running in the background. ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: {
      id: running.id,
      name: params.name,
      ...((params as any).__requestedName && (params as any).__requestedName !== params.name
        ? { requestedName: (params as any).__requestedName, renamed: true }
        : {}),
      task: params.task,
      agent: params.agent,
      sessionFile: running.sessionFile,
      launchScriptFile: running.launchScriptFile,
      status: "started",
    },
  };
}
