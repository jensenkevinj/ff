# Master Plan: Unified Fantasy Football Live Dashboard

## Goal

One web page that shows the live status of my matchups in all three leagues (ESPN, Yahoo, Sleeper): my score vs. my opponent, projections where available, and players still to play. It refreshes automatically on game days, so I don't need three tabs open.

## Status

| Step | Name | Status |
|---|---|---|
| 1 | Scaffold | ⬜ Not started |
| 2 | Sleeper adapter | ⬜ Not started |
| 3 | ESPN adapter | ⬜ Not started |
| 4 | Yahoo adapter | ⬜ Not started |
| 5 | Dashboard polish | ⬜ Not started |
| 6 | Nice-to-haves (optional) | ⬜ Not started |

Legend: ⬜ Not started · 🟨 In progress · ✅ Done

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

- **Backend:** Node 20+ with TypeScript and Fastify. The backend is required because ESPN and Yahoo block browser calls (CORS) and their credentials must stay out of the browser.
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
  error?: string;          // per-league failure shown on its card
};

type TeamScore = {
  name: string;
  owner?: string;
  points: number;
  projected?: number;      // Sleeper: usually absent
  playersRemaining?: number;
  starters?: PlayerLine[];
};

type PlayerLine = {
  name: string;
  position: string;
  points: number;
  projected?: number;
  status: "pre" | "live" | "done";
};
```

---

## Step 1: Scaffold

**Goal:** prove the end-to-end setup works using fake data.

- [ ] `npm init`; install `fastify`, `@fastify/static`, `dotenv`, `zod`; dev deps `typescript`, `tsx`, `@types/node`
- [ ] `tsconfig.json` (ES2022, NodeNext, strict)
- [ ] `src/types.ts` with the normalized model
- [ ] `src/server.ts` serves `public/` and `GET /api/matchups`, which returns 3 hard-coded mock matchups
- [ ] `public/index.html` + `app.js` + `styles.css` render one card per matchup and poll every 30s
- [ ] `.env.example` with placeholders for every future variable
- [ ] Scripts: `npm run dev` (tsx watch), `npm run build`, `npm start`

**Done when:** `npm run dev` → http://localhost:3000 shows three mock matchup cards that refresh.

---

## Step 2: Sleeper adapter

**Goal:** my real Sleeper matchup on the page. No auth needed.

- [ ] `GET /v1/state/nfl` → current week (and season)
- [ ] `GET /v1/league/{id}` → league name
- [ ] `GET /v1/league/{id}/users` + `/rosters` → find my `roster_id` by `SLEEPER_USERNAME`
- [ ] `GET /v1/league/{id}/matchups/{week}` → group by `matchup_id`, pick my pair
- [ ] Player names: cache `/v1/players/nfl` (~5MB) to `.cache/`, refreshing at most every 24h
- [ ] Map to `Matchup`; derive `status` from game times where possible

**Env:** `SLEEPER_LEAGUE_ID`, `SLEEPER_USERNAME`

**Done when:** the Sleeper card shows real teams and live points.

---

## Step 3: ESPN adapter

**Goal:** my real ESPN matchup on the page, using the unofficial API.

- [ ] `GET https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/leagues/{id}?view=mMatchupScore&view=mScoreboard&view=mTeam&view=mRoster&view=mSettings&scoringPeriodId={week}`
- [ ] Send the `espn_s2` + `SWID` cookies if the league is private
- [ ] Find my team via `SWID` in the team `owners` array (with an `ESPN_TEAM_ID` override as a fallback)
- [ ] Live score from the current scoring period; projections from roster entries
- [ ] Detect expired cookies (401 or HTML response) → card error: "refresh espn_s2/SWID"

**Env:** `ESPN_LEAGUE_ID`, `ESPN_SEASON`, `ESPN_S2`, `ESPN_SWID`, optional `ESPN_TEAM_ID`

**Done when:** the ESPN card shows real teams, live points and projections.

---

## Step 4: Yahoo adapter

**Goal:** my real Yahoo matchup on the page, through OAuth 2.0.

- [ ] Register an app at developer.yahoo.com (Fantasy Sports: Read)
- [ ] `npm run yahoo:auth`: opens the consent URL, captures the code (HTTPS localhost redirect or a paste-the-code fallback), and saves tokens to `.tokens/yahoo.json`
- [ ] Refresh the access token automatically when it's within 5 minutes of its 1h expiry; write rotated tokens back to disk
- [ ] `GET /fantasy/v2/league/nfl.l.{id}/scoreboard;week={n}?format=json`
- [ ] Helper to flatten Yahoo's numbered-key JSON
- [ ] Find my matchup via `is_owned_by_current_login`
- [ ] Revoked or missing token → card error: "re-run `npm run yahoo:auth`"

**Env:** `YAHOO_LEAGUE_ID`, `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`

**Done when:** the Yahoo card shows real data and survives a token refresh.

---

## Step 5: Dashboard polish

- [ ] Card design: both scores, a projection bar, and winning/losing/tied coloring
- [ ] LIVE badge, a "last updated" time, and a clear per-card error state
- [ ] Smart polling: 30s during game windows (Thu night, Sun, Mon night) and 5 min otherwise; pause while the tab is hidden
- [ ] Expandable starters list with per-player points and game status
- [ ] Mobile-friendly layout; dark mode

**Done when:** it's the only tab I need open on Sunday.

---

## Step 6: Nice-to-haves (optional)

- [ ] Deploy (Fly.io / Render) with simple auth, for phone access
- [ ] Flash on score changes
- [ ] Win probability (Yahoo provides it; estimate for the others)
- [ ] Browser notifications on lead changes
- [ ] Week selector to look at past weeks

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| ESPN changes its unofficial endpoint | All ESPN logic stays isolated in one adapter; the card shows an error and the other leagues keep working |
| ESPN cookies expire | Detect it and show a clear message on the card |
| Yahoo OAuth redirect URI friction | Paste-the-code fallback in the auth CLI |
| Yahoo refresh token revoked | The card says to re-run `npm run yahoo:auth` |
| Rate limits | 20s server cache; slow polling outside game windows |
| Platforms expose different fields | Optional fields in the normalized model; the UI hides what's missing |

## Inputs needed from Kevin

| Needed for | Item |
|---|---|
| Step 2 | Sleeper league ID, Sleeper username |
| Step 3 | ESPN league ID; whether it's private (if so, `espn_s2` + `SWID` cookies) |
| Step 4 | Yahoo league ID; a Yahoo developer app (walkthrough provided) |
