import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flatten, listOf } from "./yahoo-json.js";

describe("flatten", () => {
  it("turns numbered-key objects into arrays and drops `count`", () => {
    assert.deepEqual(flatten({ "0": { a: 1 }, "1": { a: 2 }, count: 2 }), [{ a: 1 }, { a: 2 }]);
  });

  it("orders numbered keys by number, not by position", () => {
    assert.deepEqual(flatten({ "10": "c", "2": "b", "1": "a", count: 3 }), ["a", "b", "c"]);
  });

  it("merges arrays of single-key objects into one object, dropping empty-array padding", () => {
    assert.deepEqual(flatten([{ team_key: "t.1" }, [], { name: "Fake News" }, []]), {
      team_key: "t.1",
      name: "Fake News",
    });
  });

  it("merges a nested property list with the object beside it", () => {
    const team = [[{ team_key: "t.1" }, { name: "Fake News" }], { win_probability: 0.5 }];
    assert.deepEqual(flatten(team), { team_key: "t.1", name: "Fake News", win_probability: 0.5 });
  });

  it("keeps an array whose keys repeat, since that is a real list", () => {
    const stats = [{ stat: { stat_id: "4", value: 1 } }, { stat: { stat_id: "5", value: 2 } }];
    assert.deepEqual(flatten(stats), stats);
  });

  it("leaves objects with ordinary keys alone, flattening what's inside", () => {
    assert.deepEqual(flatten({ week: "4", "0": { x: [{ a: 1 }, { b: 2 }] } }), {
      week: "4",
      "0": { x: { a: 1, b: 2 } },
    });
  });

  it("passes scalars, nulls and empty arrays through", () => {
    assert.deepEqual(flatten({ a: null, b: "x", c: 0, d: [] }), { a: null, b: "x", c: 0, d: [] });
  });
});

describe("listOf", () => {
  it("wraps a lone item, which flatten can't tell from a property list", () => {
    assert.deepEqual(listOf(flatten([{ stat: { stat_id: "4", value: 1 } }])), [
      { stat: { stat_id: "4", value: 1 } },
    ]);
    assert.deepEqual(listOf(undefined), []);
    assert.deepEqual(listOf([1, 2]), [1, 2]);
  });
});
