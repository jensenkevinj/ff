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

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixturesDir, `${name}.json`), "utf8"));
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
    assert.equal(m.me.projected, undefined);
    assert.deepEqual(m.me.starters, [
      { name: "Patrick Mahomes", position: "QB", points: 24.5, status: "live" },
      { name: "Justin Jefferson", position: "WR", points: 12.3, status: "live" },
      { name: "Empty", position: "", points: 0, status: "pre" },
    ]);
    // Bench = roster players not in the lineup, scored from players_points.
    assert.deepEqual(m.me.bench, [{ name: "Alvin Kamara", position: "RB", points: 9.1, status: "live" }]);

    // Opponent shares my matchup_id; with no team_name, fall back to display name.
    assert.equal(m.opponent.name, "rival");
    assert.equal(m.opponent.points, 23.2);
    assert.equal(m.opponent.starters?.[0]?.name, "Buffalo Bills");
    assert.deepEqual(m.opponent.bench, []);
  });

  it("is 'pre' before anyone scores and 'final' on Tuesday", async () => {
    const r = await defaultRoutes();
    const zeroed = (r["/league/1234/matchups/4"] as { starters_points: number[] }[]).map((m) => ({
      ...m,
      points: 0,
      starters_points: m.starters_points.map(() => 0),
    }));
    const pre = await (
      await adapter({ routes: { ...r, "/league/1234/matchups/4": zeroed } })
    ).getMatchup(silentLog);
    assert.equal(pre.status, "pre");

    const final = await (await adapter({ now: () => TUESDAY })).getMatchup(silentLog);
    assert.equal(final.status, "final");
    assert.ok(final.me.starters?.every((p) => p.status === "done"));
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
    assert.deepEqual((saved as Record<string, unknown>)["4046"], { name: "Patrick Mahomes", position: "QB" });
  });

  it("uses a stale players file if the refresh fails", async () => {
    const playersFile = path.join(dir, "stale-players.json");
    await writeFile(playersFile, JSON.stringify({ "4046": { name: "Old Name", position: "QB" } }));
    const twoDaysAgo = new Date(SUNDAY.getTime() - 48 * 60 * 60 * 1000);
    await utimes(playersFile, twoDaysAgo, twoDaysAgo);

    const r = await defaultRoutes();
    const m = await (
      await adapter({ playersFile, routes: { ...r, "/players/nfl": 503 } })
    ).getMatchup(silentLog);
    assert.equal(m.me.starters?.[0]?.name, "Old Name");
  });
});
