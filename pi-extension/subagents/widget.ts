/**
 * Widget rendering (border math + subagent rows). Extracted from index.ts (R1).
 * Pure functions — no pi dependency except via injected snapshots.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatElapsedMMSS } from "./format.ts";
import type { StatusSnapshot } from "./status.ts";

export const ACCENT = "\x1b[38;2;77;163;255m";
export const RST = "\x1b[0m";

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
export const ICON_GREEN = "\x1b[38;2;126;186;103m";
export const ICON_YELLOW = "\x1b[38;2;214;181;94m";
export const ICON_RED = "\x1b[38;2;224;108;117m";
export const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
export function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/** Build a bordered content line: │left          right│ */
export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/** Build the bordered top line: ╭─ Title ──── info ─╮ */
export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  // N15: measure visible width (CJK/wide chars), not UTF-16 length.
  const fillLen = Math.max(
    0,
    inner - visibleWidth(titlePart) - visibleWidth(infoPart),
  );
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/** Build the bordered bottom line: ╰──────────╯ */
export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export interface WidgetRow {
  name: string;
  agent?: string;
  startTime: number;
  cli?: string;
  snapshot: StatusSnapshot;
}

export function formatWidgetRightLabel(
  snapshot: StatusSnapshot,
  opts?: { statusEnabled?: boolean; cli?: string },
): string {
  if (opts && opts.statusEnabled === false) {
    return opts.cli === "claude" ? " running… " : " starting… ";
  }
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

export function renderSubagentWidgetLines(
  agents: WidgetRow[],
  width: number,
  opts?: { statusEnabled?: boolean },
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const icon = widgetIcon(agent.snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right =
      opts?.statusEnabled === false
        ? formatWidgetRightLabel(agent.snapshot, { statusEnabled: false, cli: agent.cli })
        : formatWidgetRightLabel(agent.snapshot);

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}
