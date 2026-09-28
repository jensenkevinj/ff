import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeFetch, type FakeCall } from "../testing/fake-fetch.js";
import { createSleeperAdapter, type SleeperOptions } from "./sleeper.js";

const fixturesDir = path.join(import.meta.dirname, "__fixtures__", "sleeper");
const SUNDAY = new Date("2026-09-27T18:00:00Z"); // 2pm Eastern
const TUESDAY = new Date("2026-09-29T15:00:00Z");
const silentLog = { info: () => {}, warn: () => {} };

async function fixture(name: string, dir = fixturesDir): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, `${name}.json`), "utf8"));
}

// ESPN's NFL scoreboard, shared with the ESPN tests. In it KC's game is over, BUF and WSH are playing,
// and MIN, NO and SF haven't kicked off.
type Scoreboard = { events: { competitions: { status: { type: { state: string } } }[] }[] };
const SCOREBOARD = "/apis/site/v2/sports/football/nfl/scoreboard";
const scoreboardFixture = () =>
  fixture("scoreboard", path.join(fixturesDir, "..", "espn")) as Promise<Scoreboard>;

function allGames(scoreboard: Scoreboard, state: string): Scoreboard {
  const copy = structuredClone(scoreboard);
  for (const e of copy.events) for (const c of e.competitions) c.status.type.state = state;
  return copy;
}

// Maps URL paths (after /v1) to response bodies. A number means "respond with that HTTP status".
type Routes = Record<string, unknown>;

async function defaultRoutes(): Promise<Routes> {
  return {
    "/state/nfl": await fixture("state"),
    "/league/1234": await fixture("league"),
    "/league/1234/users": await fixture("users"),
    "/league/1234/rosters": await fixture("rosters"),
    "/league/1234/matchups/4": await fixture("matchups"),
    "/players/nfl": await fixture("players"),
    "/stats/nfl/2026/4": await fixture("stats"), // on api.sleeper.com, which has no /v1 prefix
    "/projections/nfl/2026/4": await fixture("projections"),
    [SCOREBOARD]: await scoreboardFixture(),
  };
}

describe("Sleeper adapter", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ff-sleeper-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Each test gets its own players file path so the on-disk cache doesn't leak between tests.
  let n = 0;
  async function adapter(overrides: Partial<SleeperOptions> & { routes?: Routes; calls?: FakeCall[] } = {}) {
    const { routes = await defaultRoutes(), calls, ...opts } = overrides;
    return createSleeperAdapter({
      leagueId: "1234",
      username: "TestUser",
      playersFile: path.join(dir, `players-${++n}.json`),
      fetch: fakeFetch((url) => routes[url.pathname.replace(/^\/v1/, "")], calls),
      now: () => SUNDAY,
      ...opts,
    });
  }

  it("maps my matchup and opponent", async () => {
    const m = await (await adapter()).getMatchup(silentLog);

    assert.equal(m.platform, "sleeper");
    assert.equal(m.leagueName, "Test League");
    assert.equal(m.week, 4);
    assert.equal(m.status, "live");
    assert.equal(m.error, undefined);

    // Username matches display name case-insensitively; team_name is preferred when set.
    assert.equal(m.me.name, "Touchdown Machine");
    assert.equal(m.me.owner, "testuser");
    assert.equal(m.me.points, 36.8);
    // Game status comes from each player's NFL team on the scoreboard, not from their points.
    assert.deepEqual(m.me.starters, [
      {
        name: "Patrick Mahomes",
        position: "QB",
        points: 24.5,
        projected: 20.16,
        game: { score: "KC 27–17 MIA" },
        statLine: "20/24, 246 YD, 2 TD, 1 INT · 1 CAR, 1 YD",
        status: "done", // KC's game is over
      },
      {
        name: "Justin Jefferson",
        position: "WR",
        points: 12.3,
        projected: 13.8,
        game: {}, // MIN hasn't kicked off; the trimmed fixture has no kickoff time or TV
        statLine: "2 REC, 32 YD",
        status: "pre",
      },
      { name: "Empty", position: "", points: 0, status: "done" },
    ]);
    assert.equal(m.me.playersRemaining, 1);
    // Projected final: points so far plus the projection for whatever's left of each game. Mahomes is
    // done (24.5), Jefferson hasn't started (12.3 + his whole 13.8 projection), the empty slot adds 0.
    assert.equal(m.me.projected, 50.6);
    // Bench = roster players not in the lineup, scored from players_points.
    assert.deepEqual(m.me.bench, [
      {
        name: "Alvin Kamara",
        position: "RB",
        points: 9.1,
        projected: 7.03,
        game: {},
        statLine: "9 CAR, 36 YD · 1 REC, 5 YD",
        status: "pre",
      },
    ]);

    // Opponent shares my matchup_id; with no team_name, fall back to display name.
    assert.equal(m.opponent.name, "rival");
    assert.equal(m.opponent.points, 23.2);
    assert.equal(m.opponent.starters?.[0]?.name, "Buffalo Bills");
    assert.equal(m.opponent.starters?.[0]?.statLine, "2 SCK, 1 INT, 16 PA");
    assert.equal(m.opponent.starters?.[0]?.status, "live"); // a team defense's player ID is its team
    assert.equal(m.opponent.playersRemaining, 2);
    assert.equal(m.opponent.projected, 43.64); // BUF has 4:12 left in the 3rd: 32% of its 6.26 projection
    assert.deepEqual(m.opponent.starters?.[0]?.game, {
      kickoff: "2026-09-27T17:00Z",
      broadcast: "CBS",
      score: "BUF 20–13 LAC",
      clock: "4:12 3rd",
      hasBall: true,
      situation: "1st & 10 at LAC 18",
      redZone: true,
    });

    // Ahead on projection, with plenty of uncertainty left; the two sides add up to 1.
    assert.ok(m.me.winProbability! > 0.6 && m.me.winProbability! < 0.8, `got ${m.me.winProbability}`);
    assert.ok(Math.abs(m.me.winProbability! + m.opponent.winProbability! - 1) < 1e-9);
    assert.deepEqual(m.opponent.bench, []);
  });

  it("is 'pre' before any game starts and 'final' once every starter's game is over", async () => {
    const r = await defaultRoutes();
    const board = await scoreboardFixture();
    const pre = await (
      await adapter({ routes: { ...r, [SCOREBOARD]: allGames(board, "pre") } })
    ).getMatchup(silentLog);
    assert.equal(pre.status, "pre");
    const final = await (
      await adapter({ routes: { ...r, [SCOREBOARD]: allGames(board, "post") } })
    ).getMatchup(silentLog);
    assert.equal(final.status, "final");
    assert.equal(final.me.playersRemaining, 0);
  });

  it("matches Sleeper's WAS to the scoreboard's WSH", async () => {
    const r = await defaultRoutes();
    const players = r["/players/nfl"] as Record<string, { team: string }>;
    const routes = { ...r, "/players/nfl": { ...players, "4046": { ...players["4046"], team: "WAS" } } };
    const m = await (await adapter({ routes })).getMatchup(silentLog);
    assert.equal(m.me.starters?.[0]?.status, "live");
  });

  it("without the scoreboard, guesses: 'pre' before anyone scores and 'final' on Tuesday", async () => {
    const r: Routes = { ...(await defaultRoutes()), [SCOREBOARD]: 503 };
    const zeroed = (r["/league/1234/matchups/4"] as { starters_points: number[] }[]).map((m) => ({
      ...m,
      points: 0,
      starters_points: m.starters_points.map(() => 0),
    }));
    const pre = await (
      await adapter({ routes: { ...r, "/league/1234/matchups/4": zeroed } })
    ).getMatchup(silentLog);
    assert.equal(pre.status, "pre");

    const final = await (await adapter({ routes: r, now: () => TUESDAY })).getMatchup(silentLog);
    assert.equal(final.status, "final");
    assert.ok(final.me.starters?.every((p) => p.status === "done"));
  });

  it("asks for this week's stats, filtered to fantasy positions", async () => {
    const calls: FakeCall[] = [];
    await (await adapter({ calls })).getMatchup(silentLog);
    const stats = calls.find((c) => c.url.pathname.startsWith("/stats/"));
    assert.equal(stats?.url.host, "api.sleeper.com");
    assert.equal(stats?.url.searchParams.get("season_type"), "regular");
    assert.deepEqual(stats?.url.searchParams.getAll("position[]"), [
      "QB",
      "RB",
      "WR",
      "TE",
      "FB",
      "K",
      "DEF",
    ]);
  });

  it("scores each player's projection with the league's own scoring settings", async () => {
    const m = await (await adapter()).getMatchup(silentLog);
    // Sleeper's generic half-PPR projection is 20.65; this league takes 2 points per interception, not 1.
    assert.equal(m.me.starters?.[0]?.projected, 20.16);
    assert.equal(m.me.starters?.[2]?.projected, undefined); // the empty slot
  });

  it("fetches projections at most every 10 minutes", async () => {
    const calls: FakeCall[] = [];
    const a = await adapter({ calls });
    await a.getMatchup(silentLog);
    await a.getMatchup(silentLog);
    assert.equal(calls.filter((c) => c.url.pathname.startsWith("/projections/")).length, 1);
  });

  it("still shows the matchup, without projections or win probability, if projections fail", async () => {
    const r = await defaultRoutes();
    const m = await (
      await adapter({ routes: { ...r, "/projections/nfl/2026/4": 500 } })
    ).getMatchup(silentLog);
    assert.equal(m.me.points, 36.8);
    assert.equal(m.me.winProbability, undefined);
  });

  it("still shows the matchup, without stat lines, if the stats endpoint fails", async () => {
    const r = await defaultRoutes();
    const warnings: unknown[] = [];
    const log = { info: () => {}, warn: (obj: unknown) => void warnings.push(obj) };
    const m = await (await adapter({ routes: { ...r, "/stats/nfl/2026/4": 500 } })).getMatchup(log);
    assert.equal(m.me.points, 36.8);
    assert.ok(m.me.starters?.every((p) => p.statLine === undefined));
    assert.equal(warnings.length, 1);
  });

  it("falls back to looking up the username when no display name matches", async () => {
    const r = await defaultRoutes();
    const m = await (
      await adapter({ username: "OldHandle", routes: { ...r, "/user/OldHandle": { user_id: "u1" } } })
    ).getMatchup(silentLog);
    assert.equal(m.me.name, "Touchdown Machine");
  });

  it("rejects with a clear message for an unknown league", async () => {
    const r = await defaultRoutes();
    const a = await adapter({ routes: { ...r, "/league/1234": null } });
    await assert.rejects(a.getMatchup(silentLog), /Sleeper league 1234 not found/);
  });

  it("rejects with the URL and status on an HTTP error", async () => {
    const r = await defaultRoutes();
    const a = await adapter({ routes: { ...r, "/league/1234/rosters": 500 } });
    await assert.rejects(
      a.getMatchup(silentLog),
      /HTTP 500 for GET https:\/\/api\.sleeper\.app\/v1\/league\/1234\/rosters/,
    );
  });

  it("rejects when a field we rely on changes shape", async () => {
    const r = await defaultRoutes();
    const a = await adapter({ routes: { ...r, "/state/nfl": { week: "four" } } });
    await assert.rejects(a.getMatchup(silentLog), /Unexpected Sleeper response/);
  });

  it("downloads the players file once and reuses it from disk", async () => {
    const playersFile = path.join(dir, "shared-players.json");
    const calls: FakeCall[] = [];

    await (await adapter({ playersFile, calls })).getMatchup(silentLog);
    // A fresh adapter has an empty memory cache, like a server restart; it should read the file.
    await (await adapter({ playersFile, calls })).getMatchup(silentLog);

    assert.equal(calls.filter((c) => c.url.pathname === "/v1/players/nfl").length, 1);
    const saved = JSON.parse(await readFile(playersFile, "utf8")) as unknown;
    assert.deepEqual((saved as Record<string, unknown>)["4046"], {
      name: "Patrick Mahomes",
      position: "QB",
      team: "KC",
    });
  });

  it("uses a stale players file if the refresh fails", async () => {
    const playersFile = path.join(dir, "stale-players.json");
    await writeFile(
      playersFile,
      JSON.stringify({ "4046": { name: "Old Name", position: "QB", team: "KC" } }),
    );
    const twoDaysAgo = new Date(SUNDAY.getTime() - 48 * 60 * 60 * 1000);
    await utimes(playersFile, twoDaysAgo, twoDaysAgo);

    const r = await defaultRoutes();
    const m = await (
      await adapter({ playersFile, routes: { ...r, "/players/nfl": 503 } })
    ).getMatchup(silentLog);
    assert.equal(m.me.starters?.[0]?.name, "Old Name");
  });

  it("downloads the players file again if the cached one is in an old format", async () => {
    const playersFile = path.join(dir, "old-format-players.json");
    await writeFile(playersFile, JSON.stringify({ "4046": { name: "Patrick Mahomes", position: "QB" } }));
    const calls: FakeCall[] = [];
    const m = await (await adapter({ playersFile, calls })).getMatchup(silentLog);
    assert.equal(calls.filter((c) => c.url.pathname === "/v1/players/nfl").length, 1);
    assert.equal(m.me.starters?.[0]?.status, "done"); // the new file has Mahomes's team
  });
});
