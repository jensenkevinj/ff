# Master Plan: Unified Fantasy Football Live Dashboard

## Goal

One web page that shows the live status of my matchups in all three leagues (ESPN, Yahoo, Sleeper): my score vs. my opponent, projections where available, and players still to play. It refreshes automatically on game days, so I don't need three tabs open.

## Status

| Step | Name                     | Status         |
| ---- | ------------------------ | -------------- |
| 1    | Scaffold                 | ✅ Done        |
| 1.5  | Tooling & best practices | ✅ Done        |
| 2    | Sleeper adapter          | ✅ Done        |
| 3    | ESPN adapter             | ✅ Done        |
| 4    | Yahoo adapter            | ✅ Done        |
| 5    | Dashboard polish         | ✅ Done        |
| 6    | Nice-to-haves (optional) | 🟨 In progress |

Legend: ⬜ Not started · 🟨 In progress · 🟥 Blocked · ✅ Done

---

## Architecture

```
┌──────────────┐     poll every 30–60s     ┌─────────────────────────────┐
│  Browser     │ ────── GET /api/matchups ─▶│  Local Node server          │
│  (index.html)│ ◀──── normalized JSON ─────│  ├─ adapters/sleeper.ts     │──▶ api.sleeper.app
└──────────────┘                            │  ├─ adapters/espn.ts        │──▶ lm-api-reads.fantasy.espn.com
                                            │  ├─ adapters/yahoo.ts       │──▶ fantasysports.yahooapis.com
                                            │  └─ short TTL cache         │
                                            └─────────────────────────────┘
```

- **Backend:** Node 24 with TypeScript and Fastify. The backend is required because ESPN and Yahoo block browser calls (CORS) and their credentials must stay out of the browser.
- **Frontend:** one static HTML page with plain JS and CSS, no build step. It polls `/api/matchups`.
- **Config:** `.env` holds league IDs and secrets (gitignored). `.env.example` is committed.
- **Caching:** an in-memory cache with a ~20s TTL per league, so opening multiple tabs doesn't multiply upstream calls.
- **Fault isolation:** each league is fetched independently. One failing never blanks the others.

### Planned layout

```
ff/
├─ src/
│  ├─ server.ts            # Fastify app: static files + /api/matchups
│  ├─ config.ts            # loads and validates .env
│  ├─ types.ts             # normalized Matchup / TeamScore / PlayerLine
│  ├─ cache.ts             # tiny TTL cache
│  └─ adapters/
│     ├─ sleeper.ts
│     ├─ espn.ts
│     └─ yahoo.ts
├─ scripts/
│  └─ yahoo-auth.ts        # one-time OAuth CLI
├─ public/
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ .env.example
├─ package.json
└─ tsconfig.json
```

### Normalized data model

```ts
type Matchup = {
  platform: "espn" | "yahoo" | "sleeper";
  leagueName: string;
  week: number;
  me: TeamScore;
  opponent: TeamScore;
  status: "pre" | "live" | "final";
  updatedAt: string;
  error?: string; // per-league failure shown on its card
};

type TeamScore = {
  name: string;
  owner?: string;
  points: number;
  projected?: number; // expected final score
  playersRemaining?: number;
  winProbability?: number; // 0–1
  starters?: PlayerLine[];
  bench?: PlayerLine[]; // bench and IR; not counted in points
};

type PlayerLine = {
  name: string;
  position: string;
  points: number;
  projected?: number;
  statLine?: string; // "5 REC, 62 YD, 1 TD"
  status: "pre" | "live" | "done";
};
```

---

## Step 1: Scaffold

**Goal:** prove the end-to-end setup works using fake data.

- [x] `npm init`; install `fastify`, `@fastify/static`, `dotenv`, `zod`; dev deps `typescript`, `tsx`, `@types/node`
- [x] `tsconfig.json` (ES2022, NodeNext, strict)
- [x] `src/types.ts` with the normalized model
- [x] `src/server.ts` serves `public/` and `GET /api/matchups`, which returns 3 hard-coded mock matchups
- [x] `public/index.html` + `app.js` + `styles.css` render one card per matchup and poll every 30s
- [x] `.env.example` with placeholders for every future variable
- [x] Scripts: `npm run dev` (tsx watch), `npm run build`, `npm start`

**Done when:** `npm run dev` → http://localhost:3000 shows three mock matchup cards that refresh.

---

## Step 1.5: Tooling & best practices

**Goal:** a solid, idiomatic Node foundation before adding real adapters.

- [x] Pin Node 24 LTS: `.nvmrc`, fnm with auto-switch on `cd`, `engines` + `@types/node` → 24
- [x] TypeScript pinned to 6.0 (typescript-eslint doesn't support the native TS 7 compiler yet)
- [x] ESLint (typescript-eslint, type-aware) + Prettier; `lint` / `format` / `format:check` scripts
- [x] Tests with `node:test` (run through tsx); `buildApp()` split from `server.ts` so routes are tested with `app.inject()`
- [x] Graceful shutdown on SIGINT/SIGTERM
- [x] Logging: `/api/matchups` logs at warn only, `LOG_LEVEL` in config, `pino-pretty` in dev
- [x] CI: GitHub Actions runs lint, format check, typecheck, tests, build on push/PR

**Done when:** `npm run check` covers lint + typecheck + tests, and CI is green.

---

## Step 2: Sleeper adapter

**Goal:** my real Sleeper matchup on the page. No auth needed.

- [x] `GET /v1/state/nfl` → current week (and season)
- [x] `GET /v1/league/{id}` → league name
- [x] `GET /v1/league/{id}/users` + `/rosters` → find my `roster_id` by `SLEEPER_USERNAME`
- [x] `GET /v1/league/{id}/matchups/{week}` → group by `matchup_id`, pick my pair
- [x] Player names: cache `/v1/players/nfl` (~5MB) to `.cache/`, refreshing at most every 24h
- [x] Map to `Matchup`; derive `status` from game times where possible (heuristic for now: Sleeper has no game times)
- [x] `src/cache.ts` 20s TTL cache; `Promise.allSettled` so a failing league shows an error card only
- [x] Verified against the real league (week 3, live points; players file cached in `.cache/`)

**Env:** `SLEEPER_LEAGUE_ID`, `SLEEPER_USERNAME`

**Done when:** the Sleeper card shows real teams and live points.

---

## Step 3: ESPN adapter

**Goal:** my real ESPN matchup on the page, using the unofficial API.

- [x] `GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{id}?view=mTeam&view=mSettings&view=mMatchupScore&view=mScoreboard` with an `X-Fantasy-Filter` header for the current matchup period (~0.5MB instead of ~3.4MB)
- [x] Send the `espn_s2` + `SWID` cookies if the league is private
- [x] Find my team via `ESPN_TEAM_ID`, or `SWID` in the team `owners` array (public leagues have no SWID)
- [x] Live score from the current scoring period; projections from roster entries
- [x] Real game states from ESPN's public NFL scoreboard (`src/nfl-scoreboard.ts`): pre/live/final and players left
- [x] Detect expired cookies (401) → card error explaining which settings to check; a non-JSON reply is a clear error too

**Env:** `ESPN_LEAGUE_ID`, `ESPN_TEAM_ID` (or `ESPN_SWID`), optional `ESPN_SEASON`; `ESPN_S2` + `ESPN_SWID` for private leagues

**Done when:** the ESPN card shows real teams, live points and projections.

---

## Step 4: Yahoo adapter

**Goal:** my real Yahoo matchup on the page, through OAuth 2.0.

**Unblocked (2026-10-02):** Yahoo approved the app for its Fantasy API (since July 2026 it returns 403 "This
application is not authorized" to any app it hasn't approved; applied 2026-09-27).

- [x] Register an app at developer.yahoo.com (Fantasy Sports: Read)
- [x] `npm run yahoo:auth` (`src/yahoo-login.ts`): prints the consent URL, takes the pasted code (or the whole redirect URL), and saves tokens to `.tokens/yahoo.json`
- [x] Live sign-in works; consent URL asks for `scope=fspt-r` explicitly
- [x] Apply for Fantasy API access (submitted 2026-09-27)
- [x] Yahoo approves the app
- [x] Refresh the access token automatically when it's within 5 minutes of its 1h expiry; write rotated tokens back to disk (`src/adapters/yahoo-auth.ts`). Verified live: a day-old login refreshed and was saved
- [x] `GET /fantasy/v2/league/nfl.l.{id}/scoreboard` (current week): both teams' points, projected points, win probability
- [x] Helper to flatten Yahoo's numbered-key JSON (`src/adapters/yahoo-json.ts`)
- [x] Find my matchup via `is_owned_by_current_login`
- [x] Rosters (`/team/{key}/roster;week=N/players/stats;type=week;week=N`): lineup slots, injury status, points, box scores; stat lines from Yahoo's stat IDs
- [x] Records and standings (`/standings`) and the starting-slot count (`/settings`), cached 5 min and 1 h; optional, like the NFL scoreboard
- [x] Game info, injury badges and lineup alerts, as on the other cards
- [x] 401 / missing token → card error: "run `npm run yahoo:auth`"; 403 → says to check the league ID, membership, and Yahoo's app approval
- Not available from Yahoo: per-player projections (the roster API has no projected stats). The card shows team
  projections and Yahoo's win probability, but no per-player "proj" figures.

**Env:** `YAHOO_LEAGUE_ID`, `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`

**Done when:** the Yahoo card shows real data and survives a token refresh.

---

## Step 5: Dashboard polish

- [x] Card design: both scores, projected finals, a win probability bar, and winning/losing/tied coloring
- [x] LIVE badge, a "last updated" time, and a clear per-card error state (also marked on the league's tab)
- [x] Smart polling, driven by the game data rather than a calendar: every 30s while any player's game is under way
      (or past kickoff), otherwise at the next kickoff or in 5 minutes, whichever is sooner; paused while the tab
      is hidden, and refreshed as soon as it's visible again if stale
- [x] Player list (starters and bench, side by side) with per-player points, projections and game status
- [x] One tab per league instead of a grid of cards: each tab shows its live score, and the selected league's
      rosters are always shown. The tab is in the URL (`/#espn`), so it survives refreshes and can be bookmarked
- [x] Swipe left/right on the matchup to change tabs (phones), with a short slide-in
- [x] Player rows: a minimum height of name + one stat line, and lost fumbles join the last stat group, so rows
      come in two heights instead of four
- [x] Per-player stat lines ("20/24, 246 YD, 2 TD · 1 CAR, 1 YD"): ESPN from the raw stat IDs it already sends,
      Sleeper from its undocumented `api.sleeper.com/stats` endpoint (optional: the card still shows if it fails)
- [x] Sleeper game status from the NFL scoreboard (`src/nfl-scoreboard.ts`) instead of the day-of-week heuristic
      (kept as the fallback when the scoreboard is down); Sleeper cards now show players left too
- [x] Mobile-friendly layout; light and dark themes follow the device (`color-scheme`, `theme-color`), with
      readable warning colors in both

**Done when:** it's the only tab I need open on Sunday.

---

## Step 6: Nice-to-haves (optional)

- [x] Self-host on a home Windows PC on the home network: `HOST` setting, WinSW service (`deploy/windows/`), update script, README walkthrough. Running on an HP (Windows 11 Home, 8 GB); reboot and `update.ps1` verified
- [ ] Deploy (Fly.io / Render) with simple auth, for phone access. Possibly unnecessary: Tailscale on the home PC and phone gives away-from-home access without a public deploy or a login system
- [ ] Flash on score changes
- [x] Win probability bar: ESPN's own `winProbability`; for Sleeper, an estimate from projections (scored with the
      league's settings) and how much of each game is left (`src/win-probability.ts`). Sleeper cards gain
      projections too. Yahoo provides its own
- [x] Game info per player from the NFL scoreboard: kickoff time and TV before the game; score, clock and
      (when their team has the ball) down and distance during it; red-zone highlight
- [x] Injury badges (Q/D/O/IR/PUP/SUS) and lineup alerts for my team before kickoff: empty slot, starter on a
      bye or ruled out (`src/lineup-alerts.ts`); ⚠ on the league's tab
- [x] Record and standing under each team name ("0–4 · 11th"): ESPN's record and playoff seed; Sleeper ranked
      by win percentage, then points for
- [ ] Browser notifications on lead changes
- [ ] Week selector to look at past weeks

---

## Risks & mitigations

| Risk                                 | Mitigation                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ESPN changes its unofficial endpoint | All ESPN logic stays isolated in one adapter; the card shows an error and the other leagues keep working |
| ESPN cookies expire                  | Detect it and show a clear message on the card                                                           |
| Yahoo OAuth redirect URI friction    | Paste-the-code fallback in the auth CLI                                                                  |
| Yahoo refresh token revoked          | The card says to re-run `npm run yahoo:auth`                                                             |
| Rate limits                          | 20s server cache; slow polling outside game windows                                                      |
| Platforms expose different fields    | Optional fields in the normalized model; the UI hides what's missing                                     |

## Inputs needed from Kevin

| Needed for | Item                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Step 2     | Sleeper league ID, Sleeper username                                      |
| Step 3     | ESPN league ID; whether it's private (if so, `espn_s2` + `SWID` cookies) |
| Step 4     | Yahoo league ID; a Yahoo developer app (walkthrough provided)            |
