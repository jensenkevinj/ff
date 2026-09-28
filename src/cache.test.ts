import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  it("reuses a value until the TTL expires", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<number>(1000, () => now);
    const load = () => Promise.resolve(++loads);

    assert.equal(await cache.getOrLoad("k", load), 1);
    now = 999;
    assert.equal(await cache.getOrLoad("k", load), 1);
    now = 1000;
    assert.equal(await cache.getOrLoad("k", load), 2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    let loads = 0;
    const cache = new TtlCache<number>(1000);
    const load = () => Promise.resolve(++loads);

    const results = await Promise.all([cache.getOrLoad("k", load), cache.getOrLoad("k", load)]);
    assert.deepEqual(results, [1, 1]);
    assert.equal(loads, 1);
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>(1000);

    await assert.rejects(
      cache.getOrLoad("k", () => Promise.reject(new Error("boom"))),
      /boom/,
    );
    assert.equal(await cache.getOrLoad("k", () => Promise.resolve(7)), 7);
  });
});
