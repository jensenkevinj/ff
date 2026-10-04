// Win probability over time, per league, for the trend line under the win bar. Pure data in, data out (no DOM,
// no storage), so it's unit-tested from src/win-history.test.ts. app.js keeps the result in localStorage.

/** Most points kept per league: a whole Sunday of 30s polls with changes is well under this. */
export const MAX_POINTS = 500;

// Win probability moves in small steps; anything below this is the same value.
const MIN_CHANGE = 0.001;

/**
 * Adds each league's current win probability to the history and returns a new history (the input is left
 * untouched). History shape: { [platform]: { week, points: [{ t, p }] } }, `t` in ms since the epoch.
 *
 * - A league starts over when the week changes.
 * - Error cards and leagues without a win probability are skipped; their earlier points stay.
 * - While the value doesn't move, only the start and the latest time of the flat stretch are kept, so the line
 *   still draws it but hours of identical polls don't pile up.
 */
export function addPoints(history, matchups, now) {
  const next = { ...history };
  for (const m of matchups) {
    const p = m.error ? undefined : m.me.winProbability;
    if (typeof p !== "number") continue;
    const before = next[m.platform];
    const points = before?.week === m.week && Array.isArray(before.points) ? before.points : [];
    const [secondLast, last] = points.slice(-2);
    const flat = last && secondLast && same(last.p, p) && same(secondLast.p, p);
    const kept = flat ? points.slice(0, -1) : points; // extend the flat stretch instead of adding to it
    next[m.platform] = { week: m.week, points: [...kept, { t: now, p }].slice(-MAX_POINTS) };
  }
  return next;
}

function same(a, b) {
  return Math.abs(a - b) < MIN_CHANGE;
}
