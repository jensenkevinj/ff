import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { mockMatchup } from "./mock.js";
import { createSources, type MatchupSource } from "./sources.js";
import type { Matchup } from "./types.js";

describe("app", () => {
  let app: FastifyInstance;
  let espnLoads = 0;

  // Fake sources: ESPN works, Sleeper fails. No network involved.
  const sources: MatchupSource[] = [
    {
      platform: "espn",
      load: () => {
        espnLoads++;
        return Promise.resolve(mockMatchup("espn"));
      },
    },
    { platform: "sleeper", load: () => Promise.reject(new Error("Sleeper league 999 not found")) },
  ];

  before(async () => {
    app = await buildApp({ sources });
  });

  after(async () => {
    await app.close();
  });

  it("GET /api/matchups shows a failing league as an error card without blanking the others", async () => {
    // inject() sends a fake request straight into Fastify; no network port is opened.
    const res = await app.inject({ method: "GET", url: "/api/matchups" });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);

    const [espn, sleeper] = res.json<Matchup[]>();
    assert.equal(espn?.platform, "espn");
    assert.equal(espn?.error, undefined);
    assert.equal(typeof espn?.me.points, "number");

    assert.equal(sleeper?.platform, "sleeper");
    assert.equal(sleeper?.leagueName, "Sleeper");
    assert.equal(sleeper?.error, "Sleeper league 999 not found");
  });

  it("caches each league between polls", async () => {
    const before = espnLoads;
    await app.inject({ method: "GET", url: "/api/matchups" });
    await app.inject({ method: "GET", url: "/api/matchups" });
    assert.equal(espnLoads, before); // the first test already loaded it within the TTL
  });

  it("serves the dashboard page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<title>FF Live<\/title>/);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(res.statusCode, 404);
  });
});

describe("createSources", () => {
  it("skips Sleeper when it isn't configured", () => {
    const platforms = createSources(parseConfig({ SLEEPER_LEAGUE_ID: "", SLEEPER_USERNAME: "" })).map(
      (s) => s.platform,
    );
    assert.deepEqual(platforms, ["espn", "yahoo"]);
  });

  it("includes Sleeper when it is configured", () => {
    const config = parseConfig({ SLEEPER_LEAGUE_ID: "1234", SLEEPER_USERNAME: "someone" });
    assert.deepEqual(
      createSources(config).map((s) => s.platform),
      ["sleeper", "espn", "yahoo"],
    );
  });
});
