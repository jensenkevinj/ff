import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fakeFetch, type FakeCall } from "../testing/fake-fetch.js";
import { createYahooAdapter, type YahooOptions } from "./yahoo.js";

// Fixtures are real week-4 responses, trimmed to the fields the adapter reads, with league ID, team and
// people names replaced, plus a few box scores added to my starters. Team Alpha (id 4, mine) plays Team Bravo
// (id 5). Game states come from the ESPN fixture: a mix of finished, in-progress and not-started games.
const fixturesDir = path.join(import.meta.dirname, "__fixtures__");
const silentLog = { info: () => {}, warn: () => {} };

type Scoreboard = { events: { competitions: { status: { type: { state: string } } }[] }[] };
// Yahoo's raw layout: a roster's players are numbered, and each one is a list of property objects.
type RawPlayer = [Record<string, unknown>[], { selected_position: [unknown, { position: string }] }, unknown];
type RawRoster = {
  fantasy_content: {
    team: [unknown, { roster: { "0": { players: Record<string, { player: RawPlayer }> } } }];
  };
};
type RawScoreboard = {
  fantasy_content: {
    league: [unknown, { scoreboard: { "0": { matchups: Record<string, { matchup: { status: string } }> } } }];
  };
};

async function fixture<T>(dir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir, dir, `${name}.json`), "utf8")) as T;
}

// Every game on the scoreboard set to one state.
function allGames(scoreboard: Scoreboard, state: string): Scoreboard {
  const copy = structuredClone(scoreboard);
  for (const e of copy.events) for (const c of e.competitions) c.status.type.state = state;
  return copy;
}

const players = (roster: RawRoster) => roster.fantasy_content.team[1].roster["0"].players;
function player(roster: RawRoster, name: string): RawPlayer {
  const found = Object.values(players(roster)).find((p) => JSON.stringify(p.player[0]).includes(`"${name}"`));
  assert.ok(found, `no player ${name} in the fixture`);
  return found.player;
}
// Sets (or adds) one of the property objects at the top of a player, e.g. { status: "O" }.
function setProp(p: RawPlayer, key: string, value: string) {
  const prop = p[0].find((o) => key in o);
  if (prop) prop[key] = value;
  else p[0].push({ [key]: value });
}

describe("Yahoo adapter", () => {
  let scoreboard: RawScoreboard;
  let mineRoster: RawRoster;
  let theirRoster: RawRoster;
  let standings: unknown;
  let settings: unknown;
  let nflScoreboard: Scoreboard;

  before(async () => {
    scoreboard = await fixture("yahoo", "scoreboard");
    mineRoster = await fixture("yahoo", "roster-mine");
    theirRoster = await fixture("yahoo", "roster-theirs");
    standings = await fixture("yahoo", "standings");
    settings = await fixture("yahoo", "settings");
    nflScoreboard = await fixture("espn", "scoreboard");
  });

  // Each response can be replaced; a number answers with that HTTP status instead.
  function adapter(
    overrides: Partial<YahooOptions> & {
      bodies?: Partial<Record<"scoreboard" | "mine" | "theirs" | "standings" | "settings" | "nfl", unknown>>;
      calls?: FakeCall[];
    } = {},
  ) {
    const { bodies, calls, ...opts } = overrides;
    const o = {
      scoreboard,
      mine: mineRoster,
      theirs: theirRoster,
      standings,
      settings,
      nfl: nflScoreboard,
      ...bodies,
    };
    const respond = (url: URL) => {
      if (url.hostname === "site.api.espn.com") return o.nfl;
      const p = url.pathname;
      if (p.endsWith("/scoreboard")) return o.scoreboard;
      if (p.includes("/team/470.l.1234.t.4/roster")) return o.mine;
      if (p.includes("/team/470.l.1234.t.5/roster")) return o.theirs;
      if (p.endsWith("/standings")) return o.standings;
      if (p.endsWith("/settings")) return o.settings;
      return undefined;
    };
    return createYahooAdapter({
      leagueId: "1234",
      auth: { getAccessToken: () => Promise.resolve("test-token") },
      fetch: fakeFetch(respond, calls),
      now: () => new Date("2026-09-27T19:00:00Z"),
      ...opts,
    });
  }

  it("maps my matchup: teams, record, score, projection and win probability", async () => {
    const m = await adapter().getMatchup(silentLog);

    assert.equal(m.platform, "yahoo");
    assert.equal(m.leagueName, "Test League");
    assert.equal(m.week, 4);
    assert.equal(m.updatedAt, "2026-09-27T19:00:00.000Z");
    assert.equal(m.status, "live");

    assert.equal(m.me.name, "Team Alpha");
    assert.equal(m.me.owner, "Alex");
    assert.deepEqual(m.me.record, { wins: 1, losses: 2, ties: 0, rank: 6 });
    assert.equal(m.me.points, 0);
    assert.equal(m.me.projected, 129.46);
    assert.equal(m.me.winProbability, 0.53);

    assert.equal(m.opponent.name, "Team Bravo");
    assert.equal(m.opponent.owner, "Sam");
    assert.deepEqual(m.opponent.record, { wins: 2, losses: 1, ties: 0, rank: 3 });
    assert.equal(m.opponent.projected, 126.12);
    assert.equal(m.opponent.winProbability, 0.47);
  });

  it("lists starters in lineup order and puts bench and IR separately", async () => {
    const m = await adapter().getMatchup(silentLog);

    assert.deepEqual(
      m.me.starters?.map((p) => p.position),
      ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "RB", "K", "DEF"], // the RB in the W/R/T slot sits after the TE
    );
    assert.equal(m.me.starters?.length, 10);
    assert.equal(m.me.bench?.length, 6);
    assert.ok(m.me.bench?.some((p) => p.injury === "IR"));
    // Bench players' points are shown but don't count toward the team's score.
    assert.equal(m.me.bench?.find((p) => p.points === 8.9)?.statLine, "5 REC, 64 YD");
  });

  it("adds injury badges, game info and per-player status from the NFL scoreboard", async () => {
    const m = await adapter().getMatchup(silentLog);
    const [qb, , , , , wr3] = m.me.starters ?? [];

    assert.equal(qb?.status, "done"); // KC's game is over
    assert.equal(qb?.game?.score, "KC 27–17 MIA");
    assert.equal(wr3?.injury, "Q");
    assert.equal(wr3?.status, "live");
    assert.equal(m.me.playersRemaining, 7);
    assert.equal(m.opponent.playersRemaining, 8);
  });

  it("turns box scores into stat lines for players whose game has started", async () => {
    const m = await adapter({ bodies: { nfl: allGames(nflScoreboard, "post") } }).getMatchup(silentLog);
    const line = (position: string) => m.me.starters?.find((p) => p.position === position)?.statLine;

    assert.equal(line("QB"), "256 PASS YD, 2 TD, 1 INT");
    assert.equal(line("RB"), "14 CAR, 82 YD, 1 TD · 3 REC, 21 YD");
    assert.equal(line("K"), "2/3 FG, 2/2 XP"); // 2 field goals made, 1 missed; 2 extra points made
    assert.equal(line("DEF"), "3 SCK, 1 INT, 13 PA");
    assert.equal(m.status, "final");
    assert.equal(m.me.playersRemaining, 0);
  });

  it("shows no stat lines before kickoff, even though Yahoo reports zeros", async () => {
    const m = await adapter({ bodies: { nfl: allGames(nflScoreboard, "pre") } }).getMatchup(silentLog);

    assert.equal(m.status, "pre");
    assert.ok(m.me.starters?.every((p) => p.statLine === undefined && p.status === "pre"));
    assert.equal(m.me.playersRemaining, 10);
  });

  it("is final when Yahoo says the matchup is over, whatever the games say", async () => {
    const done = structuredClone(scoreboard);
    const matchup = done.fantasy_content.league[1].scoreboard["0"].matchups["0"]?.matchup;
    assert.ok(matchup);
    matchup.status = "postevent";

    assert.equal((await adapter({ bodies: { scoreboard: done } }).getMatchup(silentLog)).status, "final");
  });

  describe("lineup alerts (my team only)", () => {
    it("has none for a healthy, full lineup", async () => {
      const m = await adapter().getMatchup(silentLog);
      assert.deepEqual(m.me.alerts, []);
      assert.equal(m.opponent.alerts, undefined);
    });

    it("flags an unfilled slot, counting against the league's starting slots", async () => {
      const roster = structuredClone(mineRoster);
      const all = players(roster);
      delete all["3"]; // a WR starter; Yahoo leaves empty slots out
      const m = await adapter({ bodies: { mine: roster } }).getMatchup(silentLog);
      assert.deepEqual(m.me.alerts, ["1 empty lineup slot"]);
    });

    it("flags a starter who is out before their game", async () => {
      const roster = structuredClone(mineRoster);
      setProp(player(roster, "Test Player 7"), "status", "O"); // LV: hasn't played yet
      const m = await adapter({ bodies: { mine: roster } }).getMatchup(silentLog);
      assert.deepEqual(m.me.alerts, ["Test Player 7 is out"]);
    });

    it("flags a starter with no game this week (a bye)", async () => {
      const roster = structuredClone(mineRoster);
      setProp(player(roster, "Test Player 7"), "editorial_team_abbr", "Bye");
      const m = await adapter({ bodies: { mine: roster } }).getMatchup(silentLog);
      assert.deepEqual(m.me.alerts, ["Test Player 7 has no game this week"]);
    });
  });

  it("matches Yahoo's team abbreviations to ESPN's (Was → WSH)", async () => {
    const roster = structuredClone(mineRoster);
    setProp(player(roster, "Test Player 7"), "editorial_team_abbr", "Was"); // Yahoo's spelling
    const m = await adapter({ bodies: { mine: roster } }).getMatchup(silentLog);

    const te = m.me.starters?.find((p) => p.position === "TE");
    assert.equal(te?.game?.score, "WSH 0–0 SEA");
    assert.deepEqual(m.me.alerts, []); // found a game, so no "no game" alert
  });

  it("sends the access token and asks for JSON, one scoreboard call and one roster call per team", async () => {
    const calls: FakeCall[] = [];
    await adapter({ calls }).getMatchup(silentLog);
    const yahoo = calls.filter((c) => c.url.hostname === "fantasysports.yahooapis.com");

    assert.ok(yahoo.length >= 3);
    assert.ok(yahoo.every((c) => c.headers.get("authorization") === "Bearer test-token"));
    assert.ok(yahoo.every((c) => c.url.searchParams.get("format") === "json"));
    assert.ok(yahoo.some((c) => c.url.pathname === "/fantasy/v2/league/nfl.l.1234/scoreboard"));
    assert.ok(
      yahoo.some(
        (c) =>
          c.url.pathname === "/fantasy/v2/team/470.l.1234.t.4/roster;week=4/players/stats;type=week;week=4",
      ),
    );
  });

  it("reuses standings and settings between requests", async () => {
    const calls: FakeCall[] = [];
    const a = adapter({ calls });
    await a.getMatchup(silentLog);
    await a.getMatchup(silentLog);

    const count = (suffix: string) =>
      calls.filter((c) => c.url.hostname === "fantasysports.yahooapis.com" && c.url.pathname.endsWith(suffix))
        .length;
    assert.equal(count("/scoreboard"), 2); // live data: fetched every time
    assert.equal(count("/standings"), 1);
    assert.equal(count("/settings"), 1);
  });

  describe("errors", () => {
    it("tells you to sign in again when Yahoo rejects the token", async () => {
      await assert.rejects(adapter({ bodies: { scoreboard: 401 } }).getMatchup(silentLog), /yahoo:auth/);
    });

    it("explains a 403: league, membership, or the app not being approved", async () => {
      await assert.rejects(
        adapter({ bodies: { scoreboard: 403 } }).getMatchup(silentLog),
        /Yahoo denied access to league 1234 \(HTTP 403\).*approved/s,
      );
    });

    it("passes along a sign-in problem from the auth layer", async () => {
      const auth = {
        getAccessToken: () => Promise.reject(new Error("Not signed in to Yahoo: run `npm run yahoo:auth`")),
      };
      await assert.rejects(adapter({ auth }).getMatchup(silentLog), /Not signed in to Yahoo/);
    });

    it("says so when none of the matchups belongs to the signed-in user", async () => {
      const other = JSON.parse(
        JSON.stringify(scoreboard).replace('"is_owned_by_current_login":1', '"x":1'),
      ) as unknown;
      await assert.rejects(
        adapter({ bodies: { scoreboard: other } }).getMatchup(silentLog),
        /No Yahoo matchup for your team/,
      );
    });

    it("fails clearly when a response doesn't look like Yahoo's", async () => {
      await assert.rejects(
        adapter({ bodies: { scoreboard: { fantasy_content: {} } } }).getMatchup(silentLog),
        /Unexpected Yahoo response/,
      );
    });
  });

  describe("when optional data is unavailable", () => {
    it("falls back to guessing game status when the NFL scoreboard is down", async () => {
      const warnings: unknown[] = [];
      const log = { info: () => {}, warn: (...args: unknown[]) => void warnings.push(args) };
      const m = await adapter({ bodies: { nfl: 500 } }).getMatchup(log);

      assert.equal(m.me.playersRemaining, undefined);
      assert.equal(m.me.starters?.find((p) => p.position === "QB")?.status, "live"); // has points
      assert.equal(m.me.starters?.find((p) => p.position === "TE")?.status, "pre");
      assert.equal(warnings.length, 1);
    });

    it("shows no records when standings fail", async () => {
      const m = await adapter({ bodies: { standings: 500 } }).getMatchup(silentLog);
      assert.equal(m.me.record, undefined);
      assert.equal(m.me.name, "Team Alpha");
    });

    it("skips the empty-slot alert when settings fail", async () => {
      const roster = structuredClone(mineRoster);
      delete players(roster)["3"];
      const m = await adapter({ bodies: { mine: roster, settings: 500 } }).getMatchup(silentLog);
      assert.equal(m.me.alerts, undefined);
    });
  });
});
