# Step 4 kickoff: Yahoo adapter

Handoff written after Step 3 (2026-09-27). Goal of Step 4, from [PLAN.md](../PLAN.md): the Yahoo card shows Kevin's
real matchup, through OAuth 2.0, and keeps working across token refreshes.

## Where things stand

| Step               | Commit    | State                                        |
| ------------------ | --------- | -------------------------------------------- |
| 1–1.5              | `66b31e3` | Done                                         |
| 2: Sleeper adapter | `5433a20` | Done, verified live                          |
| 3: ESPN adapter    | `6bf30ed` | Done, verified live                          |
| 4: Yahoo adapter   | —         | Sign-in and token refresh done; adapter next |

Sleeper and ESPN are real. Yahoo is the last mock (`src/mock.ts`); delete that file once Step 4 lands.

## Progress

**Done (part 1):** `src/adapters/yahoo-auth.ts` (consent URL, code exchange, refresh with a 5-minute margin, one
refresh shared by concurrent callers, tokens saved atomically with mode 600) and `npm run yahoo:auth`
(`src/yahoo-login.ts`). `fetchJson` now supports POST with a form body. Tested; no live login yet.

**Kevin has:** created the Yahoo developer app, the Yahoo league ID (Kevin will share it again; keep it out of committed files), and set
`YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` as cloud environment variables. The two Yahoo hosts are allowed.

**Next, in order:**

1. Kevin registered `https://localhost:3000/auth/yahoo/callback` as the redirect URI, so `YAHOO_REDIRECT_URI`
   must be exactly that (not `oob`). Put it and `YAHOO_LEAGUE_ID` in `.env` if the environment variables
   aren't set. After approving, Kevin's browser fails to load that page; he pastes the whole URL from the
   address bar, and `yahoo:auth` extracts the code.
2. Run `npm run yahoo:auth`, give Kevin the URL, and have him paste back the code. In a cloud session, run it
   as `npm run yahoo:auth -- <code>` since Bash can't answer the prompt.
3. With `NODE_USE_ENV_PROXY=1`, fetch the real scoreboard and a roster, look at the shapes, then save
   trimmed, anonymized fixtures.
4. Write the adapter (`src/adapters/yahoo.ts`), wire it into `src/sources.ts`, delete `src/mock.ts`.

## Patterns to reuse

Both existing adapters follow the same shape. Copy it rather than inventing a new one.

| Piece                        | What to do                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `src/adapters/espn.ts`       | Closest model: `createXAdapter(opts)` returns `{ getMatchup(log) }`                    |
| `src/http.ts`                | `fetchJson(url, schema, { service, fetch, headers })`; `HttpError` exposes the status  |
| `src/sources.ts`             | Add Yahoo only when its env vars are set; remove the mock source                       |
| `src/nfl-scoreboard.ts`      | Player game states. Needs ESPN team IDs, so map Yahoo team abbreviations to them       |
| `src/testing/fake-fetch.ts`  | Fake `fetch` for tests; route by `url.hostname` / `url.pathname`                       |
| `src/adapters/__fixtures__/` | Real responses, trimmed, with people's names and IDs replaced. No league IDs or tokens |

Rules that carried through Steps 2–3: validate responses with zod (declare only fields used); pass `fetch` and `now`
in as options; errors should say what to fix, because the message is shown on the card; no `console.log`.

## Yahoo specifics

**OAuth 2.0 (authorization code flow).** Endpoints are on `api.login.yahoo.com`:
`/oauth2/request_auth` (browser consent) and `/oauth2/get_token` (exchange a code, or refresh). Access tokens last
1 hour; refresh them when within 5 minutes of expiry and write the new tokens to `.tokens/yahoo.json`.

- `npm run yahoo:auth` (`scripts/yahoo-auth.ts`): print the consent URL, get the code, exchange it, save tokens.
- **Redirect URI:** Yahoo requires HTTPS. Plan for the paste-the-code fallback: Yahoo supports `oob`
  (out-of-band), which shows the code on a Yahoo page for you to paste. Confirm this when registering the app.
- A missing or revoked token → card error: "re-run `npm run yahoo:auth`".
- Write token files atomically (temp file + rename, as `src/adapters/sleeper.ts` does for the players file).

**Fantasy API** (`fantasysports.yahooapis.com/fantasy/v2`, add `?format=json`):

- League key is `nfl.l.<YAHOO_LEAGUE_ID>` (`nfl` resolves to the current season's game).
- `/league/<key>/scoreboard;week=<n>` has every matchup with points and projected points; find Kevin's via
  `is_owned_by_current_login`. Omit `;week=` for the current week.
- Starters need a roster call per team: `/team/<team_key>/roster;week=<n>/players/stats;type=week;week=<n>`.
- Yahoo's JSON uses numbered keys (`"0": {...}, "1": {...}, "count": 2`) and arrays of single-key objects. Write one
  small flattening helper, test it on its own, and parse its output with zod.

## Cloud sessions

- Add `api.login.yahoo.com` and `fantasysports.yahooapis.com` to the environment's allowed domains.
- `.tokens/` is gitignored and disappears with the container. **Open question:** in cloud sessions, either re-run
  the auth flow each time or pass the refresh token in as an environment variable (never commit it). Decide with
  Kevin once it's clear whether Yahoo rotates refresh tokens.

## Needed from Kevin before coding

1. **Yahoo league ID:** the number in `football.fantasysports.yahoo.com/f1/<id>`.
2. **A Yahoo developer app** at [developer.yahoo.com/apps/create](https://developer.yahoo.com/apps/create/):
   - Application type: **Installed Application** (web apps must have a real HTTPS callback)
   - Redirect URI: `oob` if offered; otherwise `https://localhost:3000/auth/yahoo/callback`
   - API permissions: **Fantasy Sports → Read**
   - Then put the **Client ID** and **Client Secret** in `.env` (and the cloud environment's variables). Never
     commit them.

## Definition of done for Step 4

- [ ] `npm run yahoo:auth` saves tokens; the adapter refreshes them automatically and survives a refresh
- [ ] Yahoo card shows real teams, live points and projections; a revoked token shows the re-auth message
- [ ] Tests run against trimmed, anonymized fixtures with no network; `npm run check` passes
- [ ] `src/mock.ts` deleted; PLAN.md Step 4 ticked; committed as `Step 4: ...`
