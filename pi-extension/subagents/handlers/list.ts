/**
 * handlers/list.ts — trivial handler moves (T5): `subagents_list` execute +
 * `/subagent` command handler, moved as-is (no policy, no DI).
 */
import { discoverAgentDefinitions, loadAgentDefaults } from "../agents.ts";

export interface ListResult {
  content: Array<{ type: "text"; text: string }>;
  details: { agents: unknown[] };
}

export async function executeList(): Promise<ListResult> {
  const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

  if (list.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No subagent definitions found." }],
      details: { agents: [] },
    };
  }

  const lines = list.map((a) => {
    const badge = a.source === "project" ? " (project)" : "";
    const desc = a.description ? ` — ${a.description}` : "";
    const model = a.model ? ` [${a.model}]` : "";
    return `• ${a.name}${badge}${model}${desc}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { agents: list },
  };
}

export interface CommandCtx {
  ui: { notify(msg: string, level: string): void };
}

export interface CommandPi {
  sendUserMessage(msg: string): void;
}

/** `/subagent <agent> <task>` — human shortcut that routes through the tool. */
export async function handleSubagentCommand(
  pi: CommandPi,
  args: string,
  ctx: CommandCtx,
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
    return;
  }

  const spaceIdx = trimmed.indexOf(" ");
  const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const defs = loadAgentDefaults(agentName);
  if (!defs) {
    ctx.ui.notify(
      `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
      "error",
    );
    return;
  }

  const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
  const displayName = agentName[0].toUpperCase() + agentName.slice(1);
  const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
  pi.sendUserMessage(toolCall);
}
