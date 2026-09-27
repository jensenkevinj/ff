import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fetchJson, HttpError } from "../http.js";

// Yahoo OAuth 2.0 (authorization code flow). A one-time browser login (`npm run yahoo:auth`) gives us an
// access token (valid 1 hour) and a refresh token (long-lived). After that, getAccessToken() trades the
// refresh token for a new access token whenever the current one is about to expire.
const AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
// Fantasy Sports read access. Ask for it explicitly: without `scope`, Yahoo may issue a token that
// signs you in but gets HTTP 403 from the Fantasy API.
const SCOPE = "fspt-r";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh when less than 5 minutes remain

export const REAUTH_HINT = "run `npm run yahoo:auth` to sign in again";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(), // seconds
});
const storedTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(), // ms since epoch
});
export type StoredTokens = z.infer<typeof storedTokensSchema>;

export type YahooAuthOptions = {
  clientId: string;
  clientSecret: string;
  /** Must match the app's redirect URI on developer.yahoo.com exactly, e.g. `oob`. */
  redirectUri: string;
  /** Where tokens are saved, e.g. `.tokens/yahoo.json` (gitignored). */
  tokenFile: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export function createYahooAuth(opts: YahooAuthOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  let tokens: StoredTokens | undefined;
  // One refresh at a time: if several requests find the token stale together, they share one refresh
  // instead of each spending the refresh token.
  let refreshing: Promise<StoredTokens> | undefined;

  function authorizeUrl(): string {
    const params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: SCOPE,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  // Both grants go to the same endpoint, authenticated with the app's ID and secret (HTTP Basic auth).
  async function requestTokens(grant: Record<string, string>): Promise<StoredTokens> {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const body = new URLSearchParams({ redirect_uri: opts.redirectUri, ...grant });
    const res = await fetchJson(TOKEN_URL, tokenResponseSchema, {
      service: "Yahoo login",
      fetch: fetchFn,
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
      body,
    });
    const next = {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: now().getTime() + res.expires_in * 1000,
    };
    await saveTokens(opts.tokenFile, next);
    tokens = next;
    return next;
  }

  /** Step two of the login: trade the code Yahoo showed you for tokens, and save them. */
  async function exchangeCode(code: string): Promise<void> {
    try {
      await requestTokens({ grant_type: "authorization_code", code });
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        throw new Error(
          `Yahoo rejected the code (${oauthError(err.body)}). Codes work once and expire within minutes: ` +
            "run `npm run yahoo:auth` again and paste the new one right away.",
          { cause: err },
        );
      }
      throw err;
    }
  }

  async function refresh(current: StoredTokens): Promise<StoredTokens> {
    try {
      return await requestTokens({ grant_type: "refresh_token", refresh_token: current.refreshToken });
    } catch (err) {
      // 400/401 here means the refresh token is no good (revoked, or the app's secret changed).
      if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
        throw new Error(`Yahoo sign-in expired or was revoked: ${REAUTH_HINT}`, { cause: err });
      }
      throw err;
    }
  }

  /** A valid access token, refreshing it first if it expires within 5 minutes. */
  async function getAccessToken(): Promise<string> {
    tokens ??= await loadTokens(opts.tokenFile);
    if (tokens.expiresAt - now().getTime() > REFRESH_MARGIN_MS) return tokens.accessToken;

    refreshing ??= refresh(tokens).finally(() => {
      refreshing = undefined;
    });
    return (await refreshing).accessToken;
  }

  return { authorizeUrl, exchangeCode, getAccessToken };
}

/**
 * The code from what the user pasted: the redirect URL (https://localhost:3000/...?code=abc), the bare code,
 * or the code with the "Code:" label it was copied next to.
 */
export function extractCode(text: string): string {
  const trimmed = text.trim();
  try {
    const fromUrl = new URL(trimmed).searchParams.get("code");
    if (fromUrl) return fromUrl;
  } catch {
    // not a URL, so it's the code itself
  }
  return trimmed.replace(/^code:\s*/i, "");
}

// OAuth errors are JSON like {"error":"invalid_grant","error_description":"..."} (RFC 6749, section 5.2).
function oauthError(body: string): string {
  const parsed = z
    .object({ error: z.string(), error_description: z.string().optional() })
    .safeParse(safeJson(body));
  if (!parsed.success) return "HTTP 400";
  const { error, error_description } = parsed.data;
  return error_description ? `${error}: ${error_description}` : error;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function loadTokens(file: string): Promise<StoredTokens> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Not signed in to Yahoo: ${REAUTH_HINT}`, { cause: err });
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Yahoo token file ${file} is corrupted: ${REAUTH_HINT}`, { cause: err });
  }
  const parsed = storedTokensSchema.safeParse(data);
  if (!parsed.success) throw new Error(`Yahoo token file ${file} is invalid: ${REAUTH_HINT}`);
  return parsed.data;
}

async function saveTokens(file: string, tokens: StoredTokens): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // mode 0o600: only your user can read the file, since the tokens grant access to your Yahoo account.
  await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await rename(tmp, file); // atomic: a crash mid-write never leaves a half-written token file
}
