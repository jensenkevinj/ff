import type { InjuryStatus, PlayerLine } from "./types.js";

// Problems with my starting lineup worth fixing before kickoff: the "set your lineup" warnings the apps
// show. Shared by the adapters so ESPN and Sleeper word them the same way.

// Statuses that mean a starter almost certainly won't play. Questionable is too common to nag about;
// it shows as a badge instead.
const WONT_PLAY: Partial<Record<InjuryStatus, string>> = {
  O: "is out",
  D: "is doubtful",
  IR: "is on IR",
  PUP: "is on PUP",
  SUS: "is suspended",
};

export type StarterCheck = {
  line: PlayerLine;
  /** False on a bye or for a free agent; undefined when we can't tell (scoreboard unavailable). */
  hasGame: boolean | undefined;
};

export function lineupAlerts(starters: StarterCheck[], emptySlots: number): string[] {
  const alerts: string[] = [];
  if (emptySlots > 0)
    alerts.push(emptySlots === 1 ? "1 empty lineup slot" : `${emptySlots} empty lineup slots`);
  for (const { line, hasGame } of starters) {
    if (hasGame === false) alerts.push(`${line.name} has no game this week`);
    // Only before their game: once it has started, it's too late to swap them out.
    else if (line.status === "pre" && line.injury && WONT_PLAY[line.injury])
      alerts.push(`${line.name} ${WONT_PLAY[line.injury]}`);
  }
  return alerts;
}
