import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addPoints, MAX_POINTS, type WinHistory } from "../public/win-history.js";
import type { Matchup } from "./types.js";

function matchup(overrides: Partial<Matchup> & { p?: number } = {}): Matchup {
  const { p = 0.5, ...rest } = overrides;
  return {
    platform: "espn",
    leagueName: "Test League",
    week: 4,
    status: "live",
    updatedAt: "2026-10-04T18:00:00.000Z",
    me: { name: "Mine", points: 10, winProbability: p },
    opponent: { name: "Theirs", points: 20 },
    ...rest,
  };
}

// Feeds a series of win probabilities through addPoints, one poll a minute, and returns the espn points.
function run(values: number[], start: WinHistory = {}) {
  let history = start;
  values.forEach((p, i) => (history = addPoints(history, [matchup({ p })], i * 60_000)));
  return history.espn?.points;
}

describe("addPoints", () => {
  it("appends each poll's win probability", () => {
    assert.deepEqual(run([0.5, 0.6, 0.4]), [
      { t: 0, p: 0.5 },
      { t: 60_000, p: 0.6 },
      { t: 120_000, p: 0.4 },
    ]);
  });

  it("keeps only the start and end of a flat stretch", () => {
    assert.deepEqual(run([0.5, 0.7, 0.7, 0.7, 0.7, 0.6]), [
      { t: 0, p: 0.5 },
      { t: 60_000, p: 0.7 },
      { t: 240_000, p: 0.7 },
      { t: 300_000, p: 0.6 },
    ]);
  });

  it("starts over when the week changes", () => {
    const week4 = addPoints({}, [matchup({ p: 0.3 })], 0);
    const week5 = addPoints(week4, [matchup({ p: 0.8, week: 5 })], 1);
    assert.deepEqual(week5.espn, { week: 5, points: [{ t: 1, p: 0.8 }] });
  });

  it("skips error cards and leagues without a win probability, keeping their history", () => {
    const before = addPoints({}, [matchup({ p: 0.3 })], 0);
    const failed = addPoints(before, [matchup({ error: "boom" })], 1);
    const missing = addPoints(failed, [matchup({ me: { name: "Mine", points: 10 } })], 2);
    assert.deepEqual(missing, before);
  });

  it("tracks each league separately", () => {
    const history = addPoints({}, [matchup({ p: 0.3 }), matchup({ platform: "sleeper", p: 0.9 })], 0);
    assert.deepEqual(Object.keys(history).sort(), ["espn", "sleeper"]);
    assert.equal(history.sleeper?.points[0]?.p, 0.9);
  });

  it("doesn't change the history it was given", () => {
    const before = addPoints({}, [matchup({ p: 0.3 })], 0);
    const copy = structuredClone(before);
    addPoints(before, [matchup({ p: 0.6 })], 1);
    assert.deepEqual(before, copy);
  });

  it(`keeps at most ${MAX_POINTS} points, dropping the oldest`, () => {
    const values = Array.from({ length: MAX_POINTS + 10 }, (_, i) => (i % 2 ? 0.4 : 0.6));
    const points = run(values) ?? [];
    assert.equal(points.length, MAX_POINTS);
    assert.equal(points[0]?.t, 10 * 60_000);
  });
});
