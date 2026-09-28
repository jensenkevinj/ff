import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { teamTotal, winProbability } from "./win-probability.js";

const pre = (projected: number) => ({ points: 0, projected, fractionLeft: 1 });
const final = (points: number) => ({ points, projected: 10, fractionLeft: 0 });

describe("win probability", () => {
  it("is a coin flip between identical teams", () => {
    const team = teamTotal([pre(20), pre(15)]);
    assert.ok(Math.abs(winProbability(team, team) - 0.5) < 1e-6); // erf is approximated, not exact
  });

  it("favours the higher projection, and the two sides add up to 1", () => {
    const a = teamTotal([pre(120)]);
    const b = teamTotal([pre(100)]);
    const p = winProbability(a, b);
    assert.ok(p > 0.6 && p < 0.8, `got ${p}`);
    assert.ok(Math.abs(p + winProbability(b, a) - 1) < 1e-6);
  });

  it("is decided once every game is over", () => {
    assert.equal(winProbability(teamTotal([final(90)]), teamTotal([final(80)])), 1);
    assert.equal(winProbability(teamTotal([final(80)]), teamTotal([final(90)])), 0);
  });

  it("counts points already scored plus the part of the projection still to play", () => {
    const total = teamTotal([{ points: 12, projected: 20, fractionLeft: 0.25 }, final(8)]);
    assert.equal(total.mean, 12 + 5 + 8);
  });

  it("gets more certain as the clock runs down with the same expected margin", () => {
    // Both teams expect the same finish, 10 apart, but with less game left there's less time to catch up.
    const early = winProbability(teamTotal([pre(60)]), teamTotal([pre(50)]));
    const late = winProbability(
      teamTotal([{ points: 54, projected: 60, fractionLeft: 0.1 }]),
      teamTotal([{ points: 45, projected: 50, fractionLeft: 0.1 }]),
    );
    assert.ok(late > early, `${late} should be > ${early}`);
  });
});
