import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults when env is empty", () => {
    const config = parseConfig({});
    assert.equal(config.PORT, 3000);
    assert.equal(config.LOG_LEVEL, "info");
  });

  it("coerces PORT from a string", () => {
    assert.equal(parseConfig({ PORT: "8080" }).PORT, 8080);
  });

  it("treats empty strings as unset", () => {
    // .env.example ships with blank values like `SLEEPER_LEAGUE_ID=`
    assert.equal(parseConfig({ SLEEPER_LEAGUE_ID: "" }).SLEEPER_LEAGUE_ID, undefined);
  });

  it("rejects invalid values with a readable error", () => {
    assert.throws(() => parseConfig({ PORT: "not-a-number" }), /Invalid configuration[\s\S]*PORT/);
    assert.throws(() => parseConfig({ LOG_LEVEL: "loud" }), /LOG_LEVEL/);
  });
});
