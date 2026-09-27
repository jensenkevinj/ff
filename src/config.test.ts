import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLoopback, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults when env is empty", () => {
    const config = parseConfig({});
    assert.equal(config.HOST, "127.0.0.1");
    assert.equal(config.PORT, 3000);
    assert.equal(config.LOG_LEVEL, "info");
  });

  it("reads HOST, and falls back to loopback when it's blank", () => {
    assert.equal(parseConfig({ HOST: "0.0.0.0" }).HOST, "0.0.0.0");
    assert.equal(parseConfig({ HOST: "" }).HOST, "127.0.0.1");
    assert.throws(() => parseConfig({ HOST: "   " }), /HOST/);
  });

  it("coerces PORT from a string", () => {
    assert.equal(parseConfig({ PORT: "8080" }).PORT, 8080);
  });

  it("treats empty strings as unset", () => {
    // .env.example ships with blank values like `SLEEPER_LEAGUE_ID=`
    assert.equal(parseConfig({ SLEEPER_LEAGUE_ID: "" }).SLEEPER_LEAGUE_ID, undefined);
  });

  it("parses ESPN season and team ID as whole numbers", () => {
    const config = parseConfig({ ESPN_SEASON: "2026", ESPN_TEAM_ID: "1" });
    assert.equal(config.ESPN_SEASON, 2026);
    assert.equal(config.ESPN_TEAM_ID, 1);
    assert.equal(parseConfig({ ESPN_TEAM_ID: "" }).ESPN_TEAM_ID, undefined);
    assert.throws(() => parseConfig({ ESPN_TEAM_ID: "one" }), /ESPN_TEAM_ID/);
  });

  it("rejects invalid values with a readable error", () => {
    assert.throws(() => parseConfig({ PORT: "not-a-number" }), /Invalid configuration[\s\S]*PORT/);
    assert.throws(() => parseConfig({ LOG_LEVEL: "loud" }), /LOG_LEVEL/);
  });
});

describe("isLoopback", () => {
  it("recognizes addresses only this machine can reach", () => {
    for (const host of ["127.0.0.1", "127.0.1.1", "localhost", "::1"]) {
      assert.equal(isLoopback(host), true, host);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "raspberrypi.local"]) {
      assert.equal(isLoopback(host), false, host);
    }
  });
});
