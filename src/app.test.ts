import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Matchup } from "./types.js";

describe("app", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
  });

  it("GET /api/matchups returns one matchup per platform", async () => {
    // inject() sends a fake request straight into Fastify; no network port is opened.
    const res = await app.inject({ method: "GET", url: "/api/matchups" });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);

    const matchups = res.json<Matchup[]>();
    assert.deepEqual(matchups.map((m) => m.platform).sort(), ["espn", "sleeper", "yahoo"]);
    for (const m of matchups) {
      assert.equal(typeof m.me.points, "number");
      assert.equal(typeof m.opponent.points, "number");
    }
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
