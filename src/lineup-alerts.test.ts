import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lineupAlerts } from "./lineup-alerts.js";
import type { PlayerLine } from "./types.js";

const player = (name: string, extra: Partial<PlayerLine> = {}): PlayerLine => ({
  name,
  position: "WR",
  points: 0,
  status: "pre",
  ...extra,
});

describe("lineup alerts", () => {
  it("is empty for a healthy, full lineup", () => {
    assert.deepEqual(lineupAlerts([{ line: player("A"), hasGame: true }], 0), []);
  });

  it("flags byes, and doesn't guess when the scoreboard is unavailable", () => {
    assert.deepEqual(lineupAlerts([{ line: player("A"), hasGame: false }], 0), ["A has no game this week"]);
    assert.deepEqual(lineupAlerts([{ line: player("A"), hasGame: undefined }], 0), []);
  });

  it("counts empty slots", () => {
    assert.deepEqual(lineupAlerts([], 2), ["2 empty lineup slots"]);
  });

  it("flags starters who won't play, but not questionable ones or games already under way", () => {
    const alerts = lineupAlerts(
      [
        { line: player("Out", { injury: "O" }), hasGame: true },
        { line: player("Doubtful", { injury: "D" }), hasGame: true },
        { line: player("Maybe", { injury: "Q" }), hasGame: true },
        { line: player("Playing", { injury: "O", status: "live" }), hasGame: true },
      ],
      0,
    );
    assert.deepEqual(alerts, ["Out is out", "Doubtful is doubtful"]);
  });
});
