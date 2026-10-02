// Which scores moved between two polls, so the page can flash them. Pure data in, data out (no DOM), so
// it's unit-tested from src/score-changes.test.ts.

// Scores are rounded to two decimals, so anything smaller is noise, not a change.
const MIN_CHANGE = 0.005;

/** Key for a team's total: `espn|me`. */
export function teamKey(platform, side) {
  return `${platform}|${side}`;
}

/** Key for one player's points: `espn|opp|Josh Allen`. A name is unique within a roster. */
export function playerKey(platform, side, name) {
  return `${platform}|${side}|${name}`;
}

function direction(before, after) {
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  if (Math.abs(after - before) < MIN_CHANGE) return undefined;
  return after > before ? "up" : "down";
}

/**
 * Compares two API responses and returns a Map of key → "up" | "down" for every score that moved.
 * A league is skipped when it has no earlier data to compare with, when either side is an error card,
 * or when the week changed (scores reset to 0, which isn't news).
 */
export function scoreChanges(prev, next) {
  const changes = new Map();
  const add = (key, before, after) => {
    const dir = direction(before, after);
    if (dir) changes.set(key, dir);
  };

  for (const now of next) {
    const before = prev.find((m) => m.platform === now.platform);
    if (!before || before.error || now.error || before.week !== now.week) continue;

    for (const side of ["me", "opponent"]) {
      const key = side === "me" ? "me" : "opp"; // "opp" matches the CSS classes
      add(teamKey(now.platform, key), before[side].points, now[side].points);

      const earlier = new Map(
        [...(before[side].starters ?? []), ...(before[side].bench ?? [])].map((p) => [p.name, p.points]),
      );
      for (const p of [...(now[side].starters ?? []), ...(now[side].bench ?? [])]) {
        add(playerKey(now.platform, key, p.name), earlier.get(p.name), p.points);
      }
    }
  }
  return changes;
}
