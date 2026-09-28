import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fetchJson, HttpError } from "../http.js";
import type { Log } from "../log.js";

// Yahoo's Fantasy API needs an OAuth 2.0 access token. `npm run yahoo:auth` does the one-time browser
// consent (authorization code flow) and saves the tokens; after that, the token store below trades the
// refresh token for a new access token whenever the current one is about to expire (they last 1 hour).
const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const REFRESH_MARGIN_MS = 5 * 60_000;
export const REAUTH_HINT = "re-run `npm run yahoo:auth`";

export type YahooOAuthOptions = {
  clientId: string;
  clientSecret: string;
  /** Must match the redirect URI registered for the app at developer.yahoo.com exactly. */
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export type YahooTokenStoreOptions = YahooOAuthOptions & {
  /** Where tokens are saved, normally .tokens/yahoo.json (gitignored). */
  tokensFile: string;
};

export type YahooTokens = {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, as epoch milliseconds. */
  expiresAt: number;
};

// A missing, unreadable or rejected login. The message says how to fix it, since it ends up on the card.
export class YahooAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`${message}: ${REAUTH_HINT}`, options);
    this.name = "YahooAuthError";
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(), // a refresh may or may not issue a new one
  expires_in: z.number().positive(),
});

const tokensFileSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
});

/** The page to open in a browser to approve access. Yahoo then redirects to `redirectUri` with a code. */
export function consentUrl({ clientId, redirectUri }: Pick<YahooOAuthOptions, "clientId" | "redirectUri">) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
  });
  return `${AUTH_URL}?${params}`;
}

/**
 * Accepts either the bare code or the whole URL Yahoo redirected to (`...?code=abc`). Pasting the URL is
 * easier: with a localhost redirect the browser shows an error page, but the address bar holds the code.
 */
export function parseAuthCode(input: string): string {
  const trimmed = input.trim();
  let code: string | null = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    code = new URL(trimmed).searchParams.get("code");
  }
  if (!code)
    throw new Error("No authorization code found. Paste the code, or the whole URL containing ?code=");
  return code;
}

export function createYahooTokenStore(opts: YahooTokenStoreOptions) {
  const { tokensFile, fetch = globalThis.fetch, now = () => new Date() } = opts;
  let tokens: YahooTokens | undefined;
  // One refresh at a time: if two requests find the token stale together, the second waits for the first
  // instead of spending the refresh token twice.
  let refreshing: Promise<YahooTokens> | undefined;

  async function requestTokens(form: Record<string, string>, fallbackRefreshToken?: string) {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const body = new URLSearchParams({ redirect_uri: opts.redirectUri, ...form });
    const res = await fetchJson(TOKEN_URL, tokenResponseSchema, {
      service: "Yahoo login",
      fetch,
      body,
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const refreshToken = res.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken) throw new Error("Yahoo login didn't return a refresh token");
    return {
      accessToken: res.access_token,
      refreshToken,
      expiresAt: now().getTime() + res.expires_in * 1000,
    };
  }

  async function save(next: YahooTokens) {
    await mkdir(path.dirname(tokensFile), { recursive: true });
    // Temp file + rename, so a crash mid-write never leaves a half-written token file. 0o600 keeps it
    // private to this user on macOS/Linux; Windows ignores the mode and uses the folder's permissions.
    const tmp = `${tokensFile}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, tokensFile);
    tokens = next;
  }

  async function load(): Promise<YahooTokens> {
    let text: string;
    try {
      text = await readFile(tokensFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        throw new YahooAuthError("No Yahoo login saved yet");
      throw err;
    }
    const parsed = tokensFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new YahooAuthError(`Saved Yahoo login in ${tokensFile} is unreadable`);
    return parsed.data;
  }

  async function refresh(current: YahooTokens, log: Log) {
    try {
      const next = await requestTokens(
        { grant_type: "refresh_token", refresh_token: current.refreshToken },
        current.refreshToken,
      );
      await save(next);
      log.info("Refreshed Yahoo access token");
      return next;
    } catch (err) {
      // 400 invalid_grant / 401: the refresh token was revoked (app access removed, password change).
      if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
        throw new YahooAuthError("Yahoo rejected the saved login", { cause: err });
      }
      throw err;
    }
  }

  return {
    /** A valid access token, refreshing (and saving) first if it expires within 5 minutes. */
    async getAccessToken(log: Log): Promise<string> {
      tokens ??= await load();
      if (tokens.expiresAt - now().getTime() > REFRESH_MARGIN_MS) return tokens.accessToken;
      refreshing ??= refresh(tokens, log).finally(() => (refreshing = undefined));
      return (await refreshing).accessToken;
    },

    /** Trades the code from the consent page for tokens and saves them. Used by `npm run yahoo:auth`. */
    async exchangeCode(code: string): Promise<YahooTokens> {
      const next = await requestTokens({ grant_type: "authorization_code", code });
      await save(next);
      return next;
    },
  };
}

export type YahooTokenStore = ReturnType<typeof createYahooTokenStore>;
