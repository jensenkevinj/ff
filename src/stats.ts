// Platform-neutral box-score stats. Each adapter maps its own stat names onto these keys, and
// `statLine` turns them into the short summary shown under a player's name.

export const STAT_KEYS = [
  "passCmp",
  "passAtt",
  "passYd",
  "passTd",
  "passInt",
  "rushAtt",
  "rushYd",
  "rushTd",
  "rec",
  "recYd",
  "recTd",
  "fumLost",
  "fgm",
  "fga",
  "xpm",
  "xpa",
  "defSack",
  "defInt",
  "defFumRec",
  "ptsAllowed",
] as const;

// `(typeof STAT_KEYS)[number]` turns the array's literal values into a union type, so the list above
// is the single source of truth for both the runtime keys and the type.
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Partial<Record<StatKey, number>>;

/** Picks our stats out of a platform's raw stat map, given which raw key holds each one. */
export function mapStats(
  raw: Record<string, number | null | undefined>,
  keys: Record<StatKey, string>,
): Stats {
  const stats: Stats = {};
  for (const key of STAT_KEYS) {
    const value = raw[keys[key]];
    if (typeof value === "number") stats[key] = value;
  }
  return stats;
}

/**
 * "18/25, 256 YD, 1 TD · 2 CAR, -2 YD" for a QB, "0/1 FG, 2/2 XP" for a kicker, and so on.
 * Undefined when there's nothing to show yet (the game hasn't started, or the player didn't touch the ball).
 */
export function statLine(position: string, s: Stats | undefined): string | undefined {
  if (!s || Object.keys(s).length === 0) return undefined;
  const n = (key: StatKey) => s[key] ?? 0;
  // Only non-zero counts, so a line reads "62 YD" rather than "62 YD, 0 TD".
  const counts = (...pairs: [StatKey, string][]) =>
    pairs.filter(([key]) => n(key) !== 0).map(([key, label]) => `${n(key)} ${label}`);

  if (position === "K") {
    const parts = [];
    if (n("fga")) parts.push(`${n("fgm")}/${n("fga")} FG`);
    if (n("xpa")) parts.push(`${n("xpm")}/${n("xpa")} XP`);
    return join(parts, ", ");
  }
  if (position === "D/ST" || position === "DEF") {
    // Points allowed is always shown: 0 is the best possible number, not a missing one.
    return join(
      [...counts(["defSack", "SCK"], ["defInt", "INT"], ["defFumRec", "FR"]), `${n("ptsAllowed")} PA`],
      ", ",
    );
  }

  // A group shows if any of its stats is non-zero. Live feeds sometimes have the yards and TDs
  // before the attempt count; then "80 REC YD" says whose yards they are without a wrong "0 REC".
  const group = (count: string | undefined, label: string, yd: StatKey, extras: [StatKey, string][]) => {
    const rest = counts(...extras);
    if (!count && !n(yd) && rest.length === 0) return undefined;
    return join([count, `${n(yd)} ${count ? "YD" : `${label} YD`}`, ...rest], ", ");
  };
  const passing = group(n("passAtt") ? `${n("passCmp")}/${n("passAtt")}` : undefined, "PASS", "passYd", [
    ["passTd", "TD"],
    ["passInt", "INT"],
  ]);
  const rushing = group(n("rushAtt") ? `${n("rushAtt")} CAR` : undefined, "RUSH", "rushYd", [
    ["rushTd", "TD"],
  ]);
  const receiving = group(n("rec") ? `${n("rec")} REC` : undefined, "REC", "recYd", [["recTd", "TD"]]);
  // Lead with what the position is known for: a WR's catches before the odd end-around.
  const groups = (
    position === "WR" || position === "TE" ? [passing, receiving, rushing] : [passing, rushing, receiving]
  ).filter((g) => g !== undefined);
  // Lost fumbles go on the end of the last group rather than a line of their own on the page.
  if (n("fumLost")) {
    const fumbles = `${n("fumLost")} FUM`;
    const last = groups.pop();
    groups.push(last ? `${last}, ${fumbles}` : fumbles);
  }
  return join(groups, " · ");
}

function join(parts: (string | undefined)[], separator: string): string | undefined {
  const present = parts.filter((p) => p !== undefined);
  return present.length ? present.join(separator) : undefined;
}
