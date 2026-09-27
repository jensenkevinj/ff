import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeFetch, type FakeCall } from "../testing/fake-fetch.js";
import { createYahooAuth, type StoredTokens } from "./yahoo-auth.js";

const NOW = new Date("2026-09-27T20:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("Yahoo auth", () => {
  let dir: string;
  let n = 0;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ff-yahoo-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Each call to the token endpoint returns a new, numbered pair of tokens.
  function setup(respond?: (call: FakeCall) => unknown) {
    const calls: FakeCall[] = [];
    let issued = 0;
    const tokenFile = path.join(dir, `tokens-${++n}.json`);
    const auth = createYahooAuth({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "oob",
      tokenFile,
      now: () => NOW,
      fetch: fakeFetch((_url, call) => {
        if (respond) return respond(call);
        issued++;
        return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 };
      }, calls),
    });
    return { auth, calls, tokenFile };
  }

  async function saved(file: string): Promise<StoredTokens> {
    return JSON.parse(await readFile(file, "utf8")) as StoredTokens;
  }

  it("builds the consent URL", () => {
    const url = new URL(setup().auth.authorizeUrl());
    assert.equal(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
    assert.equal(url.searchParams.get("client_id"), "id");
    assert.equal(url.searchParams.get("redirect_uri"), "oob");
    assert.equal(url.searchParams.get("response_type"), "code");
  });

  it("exchanges a code for tokens and saves them privately", async () => {
    const { auth, calls, tokenFile } = setup();
    await auth.exchangeCode("abc");

    const [call] = calls;
    assert.equal(call?.method, "POST");
    assert.equal(call?.headers.get("authorization"), `Basic ${Buffer.from("id:secret").toString("base64")}`);
    const form = new URLSearchParams(call?.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "abc");
    assert.equal(form.get("redirect_uri"), "oob");

    assert.deepEqual(await saved(tokenFile), {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW.getTime() + HOUR,
    });
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal(await auth.getAccessToken(), "access-1"); // fresh, so no refresh
    assert.equal(calls.length, 1);
  });

  it("refreshes a token near expiry, once, and saves the new tokens", async () => {
    const { auth, calls, tokenFile } = setup();
    const expiring = { accessToken: "old", refreshToken: "refresh-old", expiresAt: NOW.getTime() + 60_000 };
    await writeFile(tokenFile, JSON.stringify(expiring));

    // Three requests at once share one refresh.
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    assert.deepEqual(tokens, ["access-1", "access-1", "access-1"]);
    assert.equal(calls.length, 1);

    const form = new URLSearchParams(calls[0]?.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh-old");
    assert.equal((await saved(tokenFile)).refreshToken, "refresh-1"); // a rotated refresh token is kept
  });

  it("says to sign in when there are no tokens", async () => {
    await assert.rejects(setup().auth.getAccessToken(), /Not signed in to Yahoo: run `npm run yahoo:auth`/);
  });

  it("says to sign in again when the refresh token is rejected", async () => {
    const { auth, tokenFile } = setup(() => 400);
    await writeFile(tokenFile, JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 0 }));
    await assert.rejects(auth.getAccessToken(), /expired or was revoked: run `npm run yahoo:auth`/);
  });
});
