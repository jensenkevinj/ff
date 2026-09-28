import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fakeFetch } from "./testing/fake-fetch.js";
import { fetchNflGames } from "./nfl-scoreboard.js";

const fixture = path.join(import.meta.dirname, "adapters", "__fixtures__", "espn", "scoreboard.json");

async function games() {
  const scoreboard = JSON.parse(await readFile(fixture, "utf8")) as unknown;
  return fetchNflGames({ season: 2026, week: 3, fetch: fakeFetch(() => scoreboard) });
}

describe("NFL scoreboard", () => {
  it("gives the team with the ball its down, distance and red-zone flag", async () => {
    const buf = (await games()).byAbbreviation.get("BUF");
    assert.equal(buf?.state, "in");
    assert.deepEqual(buf?.info, {
      kickoff: "2026-09-27T17:00Z",
      broadcast: "CBS",
      score: "BUF 20–13 LAC",
      clock: "4:12 3rd",
      hasBall: true,
      situation: "1st & 10 at LAC 18",
      redZone: true,
    });
  });

  it("shows the other side of the same game from its own point of view", async () => {
    const lac = (await games()).byTeamId.get(24);
    assert.deepEqual(lac?.info, {
      kickoff: "2026-09-27T17:00Z",
      broadcast: "CBS",
      score: "LAC 13–20 BUF",
      clock: "4:12 3rd",
    });
  });

  it("has kickoff and TV before a game, and the final score after", async () => {
    const g = await games();
    assert.deepEqual(g.byAbbreviation.get("PHI")?.info, { kickoff: "2026-09-29T00:15Z", broadcast: "ESPN" });
    assert.deepEqual(g.byAbbreviation.get("KC")?.info, { score: "KC 27–17 MIA" });
  });

  it("works out how much of each game is left from the quarter and clock", async () => {
    const g = await games();
    // 4:12 left in the 3rd: one full quarter plus 252 seconds, out of four quarters.
    assert.equal(g.byAbbreviation.get("BUF")?.fractionLeft, (900 + 252) / 3600);
    assert.equal(g.byAbbreviation.get("KC")?.fractionLeft, 0);
    assert.equal(g.byAbbreviation.get("PHI")?.fractionLeft, 1);
    assert.equal(g.byAbbreviation.get("CLE")?.fractionLeft, 0.5); // in progress, but no clock in the data
  });

  it("leaves out teams on a bye", async () => {
    const g = await games();
    assert.equal(g.byAbbreviation.size, 32);
    assert.equal(g.byAbbreviation.get("OAK"), undefined);
  });
});
