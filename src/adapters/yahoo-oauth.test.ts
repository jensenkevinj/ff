import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeFetch, type FakeCall } from "../testing/fake-fetch.js";
import {
  consentUrl,
  createYahooTokenStore,
  parseAuthCode,
  YahooAuthError,
  type YahooTokens,
} from "./yahoo-oauth.js";

const NOW = new Date("2026-09-27T18:00:00Z");
const silentLog = { info: () => {}, warn: () => {} };
const app = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "oob" };

describe("consentUrl", () => {
  it("asks for an authorization code for this app and redirect URI", () => {
    const url = new URL(consentUrl(app));
    assert.equal(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("redirect_uri"), "oob");
    assert.equal(url.searchParams.get("response_type"), "code");
  });
});

describe("parseAuthCode", () => {
  it("accepts a bare code, trimming whitespace", () => {
    assert.equal(parseAuthCode("  abc123 \n"), "abc123");
  });

  it("pulls the code out of a pasted redirect URL", () => {
    assert.equal(parseAuthCode("https://localhost:3000/auth/yahoo/callback?code=abc123&state="), "abc123");
  });

  it("rejects a URL without a code", () => {
    assert.throws(
      () => parseAuthCode("https://localhost:3000/auth/yahoo/callback?error=access_denied"),
      /No authorization code/,
    );
  });
});

describe("Yahoo token store", () => {
  let dir: string;
  let n = 0;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ff-yahoo-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A fresh file per test, optionally pre-filled with saved tokens.
  async function tokensFile(saved?: YahooTokens): Promise<string> {
    const file = path.join(dir, `tokens-${n++}.json`);
    if (saved) await writeFile(file, JSON.stringify(saved));
    return file;
  }

  function tokenEndpoint(response: unknown, calls: FakeCall[] = []) {
    return fakeFetch((url) => (url.pathname === "/oauth2/get_token" ? response : undefined), calls);
  }

  const minutesFromNow = (m: number) => NOW.getTime() + m * 60_000;
  const saved = (expiresAt: number): YahooTokens => ({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt,
  });

  it("exchanges a code for tokens and saves them", async () => {
    const file = await tokensFile();
    const calls: FakeCall[] = [];
    const store = createYahooTokenStore({
      ...app,
      tokensFile: file,
      now: () => NOW,
      fetch: tokenEndpoint({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }, calls),
    });

    const tokens = await store.exchangeCode("the-code");

    assert.deepEqual(tokens, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: minutesFromNow(60),
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), tokens);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), `Basic ${btoa("client-id:client-secret")}`);
    const form = new URLSearchParams(calls[0]?.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code");
    assert.equal(form.get("redirect_uri"), "oob");
  });

  it("uses the saved access token while it has more than 5 minutes left", async () => {
    const calls: FakeCall[] = [];
    const store = createYahooTokenStore({
      ...app,
      tokensFile: await tokensFile(saved(minutesFromNow(6))),
      now: () => NOW,
      fetch: tokenEndpoint(500, calls),
    });

    assert.equal(await store.getAccessToken(silentLog), "old-access");
    assert.equal(calls.length, 0);
  });

  it("refreshes a token that expires within 5 minutes and saves the new one", async () => {
    const file = await tokensFile(saved(minutesFromNow(4)));
    const calls: FakeCall[] = [];
    const store = createYahooTokenStore({
      ...app,
      tokensFile: file,
      now: () => NOW,
      fetch: tokenEndpoint(
        { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
        calls,
      ),
    });

    assert.equal(await store.getAccessToken(silentLog), "new-access");
    const form = new URLSearchParams(calls[0]?.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "old-refresh");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: minutesFromNow(60),
    });
  });

  it("keeps the old refresh token when Yahoo doesn't send a new one", async () => {
    const file = await tokensFile(saved(minutesFromNow(-10)));
    const store = createYahooTokenStore({
      ...app,
      tokensFile: file,
      now: () => NOW,
      fetch: tokenEndpoint({ access_token: "new-access", expires_in: 3600 }),
    });

    await store.getAccessToken(silentLog);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as YahooTokens;
    assert.equal(onDisk.refreshToken, "old-refresh");
  });

  it("refreshes once when several requests find the token stale at the same time", async () => {
    const calls: FakeCall[] = [];
    const store = createYahooTokenStore({
      ...app,
      tokensFile: await tokensFile(saved(minutesFromNow(1))),
      now: () => NOW,
      fetch: tokenEndpoint({ access_token: "new-access", expires_in: 3600 }, calls),
    });

    const tokens = await Promise.all([store.getAccessToken(silentLog), store.getAccessToken(silentLog)]);
    assert.deepEqual(tokens, ["new-access", "new-access"]);
    assert.equal(calls.length, 1);
  });

  it("asks to re-run yahoo:auth when the refresh token is rejected", async () => {
    const store = createYahooTokenStore({
      ...app,
      tokensFile: await tokensFile(saved(minutesFromNow(-10))),
      now: () => NOW,
      fetch: tokenEndpoint(400),
    });

    await assert.rejects(store.getAccessToken(silentLog), (err) => {
      assert.ok(err instanceof YahooAuthError);
      assert.match(err.message, /Yahoo rejected the saved login: re-run `npm run yahoo:auth`/);
      return true;
    });
  });

  it("asks to run yahoo:auth when no tokens are saved", async () => {
    const store = createYahooTokenStore({
      ...app,
      tokensFile: await tokensFile(),
      fetch: tokenEndpoint(500),
    });
    await assert.rejects(
      store.getAccessToken(silentLog),
      /No Yahoo login saved yet: re-run `npm run yahoo:auth`/,
    );
  });
});
