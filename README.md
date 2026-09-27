# ff

A single-page live dashboard for my fantasy football matchups across ESPN, Yahoo, and Sleeper. One card per league
shows my score vs. my opponent, projections where the platform has them, and how many starters are still to play.
It refreshes every 30 seconds.

See [PLAN.md](PLAN.md) for the implementation plan and status.

| League  | Status                                                                            |
| ------- | --------------------------------------------------------------------------------- |
| Sleeper | Live data                                                                         |
| ESPN    | Live data, projections, real NFL game states                                      |
| Yahoo   | Off for now: sign-in works; waiting on Yahoo's API approval (see [Yahoo](#yahoo)) |

## Running

Requires Node 24 (pinned in `.nvmrc`). With [fnm](https://github.com/Schniz/fnm) set up, `cd`-ing into the repo
switches to it automatically.

```sh
npm ci                 # install exactly what package-lock.json pins
cp .env.example .env   # then fill in the leagues you want (see below)
npm run dev            # http://localhost:3000, restarts on file changes
```

Leagues whose settings are blank are left off the page, and the startup log lists which ones are active. If one
league fails (bad ID, expired cookies, API down), its card shows the error and the others keep working.

## Configuration

All settings live in `.env` (gitignored). `.env.example` lists every variable.

### Sleeper

| Variable            | Where to find it                             |
| ------------------- | -------------------------------------------- |
| `SLEEPER_LEAGUE_ID` | The number in `sleeper.com/leagues/<id>/...` |
| `SLEEPER_USERNAME`  | Your Sleeper username (case doesn't matter)  |

The first request downloads Sleeper's player list (~5MB), trims it to names and positions, and caches it in
`.cache/sleeper-players.json` for 24 hours.

### ESPN

| Variable         | Where to find it                                                                |
| ---------------- | ------------------------------------------------------------------------------- |
| `ESPN_LEAGUE_ID` | `leagueId=` in your league page's URL                                           |
| `ESPN_TEAM_ID`   | `teamId=` in your team page's URL. Required unless `ESPN_SWID` identifies you   |
| `ESPN_SEASON`    | Optional; defaults to the current NFL season                                    |
| `ESPN_S2`        | Private leagues only: the `espn_s2` cookie from a logged-in browser on espn.com |
| `ESPN_SWID`      | Private leagues only: the `SWID` cookie, including its `{braces}`               |

ESPN's fantasy API is unofficial. If the card says access was denied, check the league ID and season, and for a
private league copy fresh cookies (they expire).

### Yahoo

**Waiting on Yahoo.** Since July 2026, Yahoo's Fantasy Sports API only answers apps its Fantasy team has approved;
any other app gets HTTP 403 ("This application is not authorized to perform this action") on every endpoint, even
with a valid sign-in. I've applied for read-only access for this personal, single-league dashboard at
[sports.yahoo.com/developer/access](https://sports.yahoo.com/developer/access/). Until then the page has no Yahoo
card.

What's already built: OAuth 2.0 sign-in (`npm run yahoo:auth`) and automatic token refresh
(`src/adapters/yahoo-auth.ts`). The adapter that reads the scoreboard comes once access is approved.

| Variable              | Where to find it                                                                  |
| --------------------- | --------------------------------------------------------------------------------- |
| `YAHOO_LEAGUE_ID`     | The number in `football.fantasysports.yahoo.com/f1/<id>`                          |
| `YAHOO_CLIENT_ID`     | Your app on [developer.yahoo.com/apps](https://developer.yahoo.com/apps/)         |
| `YAHOO_CLIENT_SECRET` | Same page as the client ID                                                        |
| `YAHOO_REDIRECT_URI`  | Exactly the redirect URI registered on the app, e.g. `https://localhost:3000/...` |

`npm run yahoo:auth` prints a Yahoo URL. After you approve, the browser fails to load the `localhost` page; paste
that page's full address back into the prompt. Tokens are saved to `.tokens/yahoo.json` (gitignored).

## Scripts

| Script               | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `npm run dev`        | Run from TypeScript source with auto-restart and pretty logs    |
| `npm test`           | Run tests (`src/**/*.test.ts`) with Node's built-in test runner |
| `npm run lint`       | ESLint, including type-aware TypeScript rules                   |
| `npm run format`     | Format everything with Prettier                                 |
| `npm run typecheck`  | Type-check everything, including tests, without emitting        |
| `npm run check`      | Lint + format check + typecheck + tests (what CI runs)          |
| `npm run build`      | Compile to `dist/` (tests excluded)                             |
| `npm start`          | Run the compiled server                                         |
| `npm run yahoo:auth` | One-time Yahoo sign-in; saves tokens to `.tokens/yahoo.json`    |

## How it's built

A Fastify server (`src/`) calls each platform's API, normalizes the result into one `Matchup` shape
(`src/types.ts`), and serves `GET /api/matchups`. A static page (`public/`) polls it. The server exists because ESPN
and Yahoo block browser calls and their credentials must stay out of the browser.

| Path                    | Role                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `src/adapters/*.ts`     | One adapter per platform; each returns a `Matchup`                             |
| `src/sources.ts`        | Picks the configured leagues from `.env`                                       |
| `src/app.ts`            | The route: runs every league in parallel, 20s cache, errors become error cards |
| `src/nfl-scoreboard.ts` | Real NFL game states (not started / in progress / final) from ESPN             |
| `src/http.ts`           | Shared fetch-and-validate helper (timeouts, clear errors, zod checks)          |
