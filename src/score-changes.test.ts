import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { playerKey, scoreChanges, teamKey } from "../public/score-changes.js";
import type { Matchup, PlayerLine } from "./types.js";

const player = (name: string, points: number): PlayerLine => ({
  name,
  position: "RB",
  points,
  status: "live",
});

function matchup(overrides: Partial<Matchup> & { mine?: number; theirs?: number } = {}): Matchup {
  const { mine = 10, theirs = 20, ...rest } = overrides;
  return {
    platform: "espn",
    leagueName: "Test League",
    week: 4,
    status: "live",
    updatedAt: "2026-10-04T18:00:00.000Z",
    me: {
      name: "Mine",
      points: mine,
      starters: [player("Alice", 6), player("Bob", 4)],
      bench: [player("Cara", 0)],
    },
    opponent: { name: "Theirs", points: theirs, starters: [player("Dan", 20)] },
    ...rest,
  };
}

describe("scoreChanges", () => {
  it("is empty when nothing moved", () => {
    assert.equal(scoreChanges([matchup()], [matchup()]).size, 0);
  });

  it("marks a team total and the player who scored, with the direction", () => {
    const next = matchup({ mine: 16 });
    next.me.starters![0].points = 12; // Alice +6
    next.opponent.points = 18.5; // down: a stat correction

    const changes = scoreChanges([matchup()], [next]);

    assert.equal(changes.get(teamKey("espn", "me")), "up");
    assert.equal(changes.get(teamKey("espn", "opp")), "down");
    assert.equal(changes.get(playerKey("espn", "me", "Alice")), "up");
    assert.equal(changes.has(playerKey("espn", "me", "Bob")), false);
    assert.equal(changes.size, 3);
  });

  it("includes bench players and the opponent's players", () => {
    const next = matchup();
    next.me.bench![0].points = 2.5;
    next.opponent.starters![0].points = 23;

    const changes = scoreChanges([matchup()], [next]);

    assert.equal(changes.get(playerKey("espn", "me", "Cara")), "up");
    assert.equal(changes.get(playerKey("espn", "opp", "Dan")), "up");
  });

  it("ignores changes smaller than the two decimals the page shows", () => {
    const next = matchup({ mine: 10.004 });
    assert.equal(scoreChanges([matchup()], [next]).size, 0);
  });

  it("doesn't flash a player who is new to the roster", () => {
    const next = matchup();
    next.me.starters!.push(player("Eve", 9)); // just added: no earlier score to compare
    assert.equal(scoreChanges([matchup()], [next]).size, 0);
  });

  it("keeps leagues apart", () => {
    const sleeper = matchup({ platform: "sleeper" });
    const next = [matchup({ mine: 13 }), sleeper];

    const changes = scoreChanges([matchup(), sleeper], next);

    assert.deepEqual([...changes.keys()], [teamKey("espn", "me")]);
  });

  it("skips a league on the first load, after an error, or when the week changes", () => {
    const moved = matchup({ mine: 30 });
    assert.equal(scoreChanges([], [moved]).size, 0);
    assert.equal(scoreChanges([matchup({ error: "ESPN is down" })], [moved]).size, 0);
    assert.equal(scoreChanges([matchup()], [matchup({ error: "ESPN is down" })]).size, 0);
    assert.equal(scoreChanges([matchup({ week: 3, mine: 90 })], [matchup({ week: 4, mine: 0 })]).size, 0);
  });
});
