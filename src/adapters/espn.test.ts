import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fakeFetch, type FakeCall } from "../testing/fake-fetch.js";
import { createEspnAdapter, type EspnOptions } from "./espn.js";

// Fixtures are a real week-3 response, trimmed and with people's names and IDs replaced.
// Team 1 (away) plays team 10 (home); some games are in progress, some haven't started.
const fixturesDir = path.join(import.meta.dirname, "__fixtures__", "espn");
const SWID_TEAM_1 = "{00000001-0000-4000-8000-000000000001}";
const silentLog = { info: () => {}, warn: () => {} };

type Scoreboard = { events: { competitions: { status: { type: { state: string } } }[] }[] };

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, `${name}.json`), "utf8"));
}

// Every game on the scoreboard set to one state.
function allGames(scoreboard: Scoreboard, state: string): Scoreboard {
  const copy = structuredClone(scoreboard);
  for (const e of copy.events) for (const c of e.competitions) c.status.type.state = state;
  return copy;
}

describe("ESPN adapter", () => {
  let league: unknown;
  let scoreboard: Scoreboard;

  before(async () => {
    league = await fixture("league");
    scoreboard = (await fixture("scoreboard")) as Scoreboard;
  });

  function adapter(
    overrides: Partial<EspnOptions> & {
      leagueBody?: unknown;
      scoreboardBody?: unknown;
      calls?: FakeCall[];
    } = {},
  ) {
    const { leagueBody = league, scoreboardBody = scoreboard, calls, ...opts } = overrides;
    const respond = (url: URL) => (url.hostname === "site.api.espn.com" ? scoreboardBody : leagueBody);
    return createEspnAdapter({
      leagueId: "1234",
      season: 2026,
      teamId: 1,
      fetch: fakeFetch(respond, calls),
      now: () => new Date("2026-09-27T19:00:00Z"),
      ...opts,
    });
  }

  it("maps my matchup, projections and starters", async () => {
    const m = await adapter().getMatchup(silentLog);

    assert.equal(m.platform, "espn");
    assert.equal(m.leagueName, "Test League");
    assert.equal(m.week, 3);
    assert.equal(m.status, "live");

    assert.equal(m.me.name, "Team 1");
    assert.equal(m.me.owner, "First1 Last1");
    assert.equal(m.me.points, 58.88); // the live total, not totalPoints (0 until the week is final)
    assert.equal(m.me.projected, 113.19);
    assert.equal(m.me.playersRemaining, 9);

    // Starters only (no bench or IR), in lineup order, each with its game's state.
    assert.deepEqual(
      m.me.starters?.map((p) => `${p.position} ${p.name} ${p.status}`),
      [
        "QB Bryce Young live",
        "RB Bucky Irving pre",
        "RB Jaylen Warren live",
        "WR Zay Flowers pre",
        "WR Mike Evans pre",
        "WR KC Concepcion live",
        "TE Harold Fannin Jr. live",
        "RB Saquon Barkley pre",
        "D/ST Texans D/ST live",
      ],
    );
    assert.deepEqual(m.me.starters?.[0], {
      name: "Bryce Young",
      position: "QB",
      points: 14.08,
      projected: 16.75,
      status: "live",
    });

    assert.equal(m.opponent.name, "Team 3");
    assert.equal(m.opponent.points, 39.06);
    assert.equal(m.opponent.projected, 64.86);
  });

  it("asks for the current matchup period and the same NFL week", async () => {
    const calls: FakeCall[] = [];
    await adapter({ calls }).getMatchup(silentLog);

    const [leagueCall, scoreboardCall] = calls;
    assert.match(leagueCall?.headers.get("x-fantasy-filter") ?? "", /filterCurrentMatchupPeriod/);
    assert.equal(leagueCall?.headers.get("cookie"), null); // public league: no cookies
    assert.equal(scoreboardCall?.url.searchParams.get("week"), "3");
  });

  it("is 'pre' before kickoff and 'final' once every game is over", async () => {
    const pre = await adapter({ scoreboardBody: allGames(scoreboard, "pre") }).getMatchup(silentLog);
    assert.equal(pre.status, "pre");

    const final = await adapter({ scoreboardBody: allGames(scoreboard, "post") }).getMatchup(silentLog);
    assert.equal(final.status, "final");
    assert.equal(final.me.playersRemaining, 0);
  });

  it("finds my team by SWID and sends the cookies for a private league", async () => {
    const calls: FakeCall[] = [];
    const m = await adapter({ teamId: undefined, swid: SWID_TEAM_1, espnS2: "s2value", calls }).getMatchup(
      silentLog,
    );
    assert.equal(m.me.name, "Team 1");
    assert.equal(calls[0]?.headers.get("cookie"), `espn_s2=s2value; SWID=${SWID_TEAM_1}`);
  });

  it("explains how to fix a 401", async () => {
    await assert.rejects(
      adapter({ leagueBody: 401 }).getMatchup(silentLog),
      /ESPN denied access to league 1234 \(HTTP 401\)\. If the league is private, set ESPN_S2/,
    );
  });

  it("says what to set when it can't tell which team is mine", async () => {
    await assert.rejects(adapter({ teamId: undefined }).getMatchup(silentLog), /set ESPN_TEAM_ID/);
  });

  it("still shows the matchup if the NFL scoreboard is down", async () => {
    const m = await adapter({ scoreboardBody: 500 }).getMatchup(silentLog);
    assert.equal(m.me.points, 58.88);
    assert.equal(m.me.playersRemaining, undefined); // unknown without game states
    assert.equal(m.me.starters?.[0]?.status, "live"); // has points
    assert.equal(m.me.starters?.[1]?.status, "pre"); // no points yet
  });
});
