import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapStats, statLine, STAT_KEYS, type StatKey } from "./stats.js";

describe("statLine", () => {
  it("is undefined when there are no stats yet", () => {
    assert.equal(statLine("QB", undefined), undefined);
    assert.equal(statLine("WR", {}), undefined);
    assert.equal(statLine("RB", { rushAtt: 0, rec: 0 }), undefined); // active, but never touched the ball
  });

  it("leads with receiving for WRs and TEs, rushing for everyone else", () => {
    const s = { rushAtt: 1, rushYd: 12, rec: 6, recYd: 88, recTd: 1 };
    assert.equal(statLine("WR", s), "6 REC, 88 YD, 1 TD · 1 CAR, 12 YD");
    assert.equal(statLine("RB", s), "1 CAR, 12 YD · 6 REC, 88 YD, 1 TD");
  });

  it("labels yards when the feed has them before the catch or carry count", () => {
    // Real Sleeper row mid-game: rec_yd and rec_td, but no `rec` yet.
    assert.equal(
      statLine("WR", { rushAtt: 2, rushYd: 14, recYd: 80, recTd: 1 }),
      "80 REC YD, 1 TD · 2 CAR, 14 YD",
    );
  });

  it("adds lost fumbles at the end", () => {
    assert.equal(
      statLine("QB", { passCmp: 14, passAtt: 25, passYd: 199, passInt: 2, fumLost: 1 }),
      "14/25, 199 YD, 2 INT · 1 FUM",
    );
  });

  it("formats kickers as made/attempted", () => {
    assert.equal(statLine("K", { fgm: 0, fga: 1, xpm: 2, xpa: 2 }), "0/1 FG, 2/2 XP");
    assert.equal(statLine("K", { xpm: 1, xpa: 1 }), "1/1 XP");
  });

  it("always shows points allowed for a defense, even a shutout", () => {
    assert.equal(statLine("DEF", { defSack: 1 }), "1 SCK, 0 PA");
    assert.equal(
      statLine("D/ST", { defSack: 4, defInt: 1, defFumRec: 2, ptsAllowed: 19 }),
      "4 SCK, 1 INT, 2 FR, 19 PA",
    );
  });
});

describe("mapStats", () => {
  it("keeps only numeric values for the mapped keys", () => {
    const keys = Object.fromEntries(STAT_KEYS.map((k) => [k, k])) as Record<StatKey, string>;
    assert.deepEqual(mapStats({ rec: 5, recYd: null, unrelated: 3 }, keys), { rec: 5 });
  });
});
