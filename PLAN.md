# Implementation Plan

## Goal

One page that shows the live status of my matchups in all three leagues (ESPN, Yahoo, Sleeper): my score vs. my opponent, projections where available, and players still to play. It refreshes automatically on game days.

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

- **Backend:** Node 20+ with TypeScript and Fastify (or Express). The backend is required because ESPN and Yahoo block browser calls (CORS) and their credentials must stay out of the browser.
- **Frontend:** one static HTML page with plain JS and CSS, no build step. It polls `/api/matchups`.
- **Config:** `.env` holds league IDs and secrets (gitignored). `.env.example` is committed.
- **Caching:** an in-memory cache with a ~20s TTL per league, so opening multiple tabs doesn't multiply upstream calls.

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
  error?: string;          // per-league failure shown on its card; other leagues still render
};

type TeamScore = {
  name: string;
  owner?: string;
  points: number;
  projected?: number;      // Sleeper: usually absent
  playersRemaining?: number;
  starters?: PlayerLine[]; // optional detail view
};

type PlayerLine = { name: string; position: string; points: number; projected?: number; status: "pre" | "live" | "done" };
```

## Phases

### Phase 0: Scaffold
- `package.json`, `tsconfig.json`, `src/server.ts`, `public/index.html`, `.env.example`
- `npm run dev` (tsx watch) serves the page plus a stub `/api/matchups`
- **Done when:** the page loads and renders hard-coded fake matchups.

### Phase 1: Sleeper adapter (easiest, no auth)
- `GET /state/nfl` → current week
- `GET /league/{id}/users` + `/rosters` → find my `roster_id` by `SLEEPER_USERNAME`
- `GET /league/{id}/matchups/{week}` → group by `matchup_id`, pick my pair
- Player names: cache `/players/nfl` to disk (`.cache/`), refreshing at most once every 24h
- **Done when:** my real Sleeper matchup shows on the page.

### Phase 2: ESPN adapter (unofficial API)
- `GET .../seasons/{year}/segments/0/leagues/{id}?view=mMatchupScore&view=mScoreboard&view=mTeam&view=mRoster&scoringPeriodId={week}`
- Send `espn_s2` + `SWID` cookies from `.env` if the league is private
- Find my team via `SWID` (matches the team `owners` array), or via an `ESPN_TEAM_ID` override
- Use `pointsByScoringPeriod` for the live score; take projections from roster entries
- Detect cookie expiry (401/redirect) and report it clearly on the card
- **Done when:** my ESPN matchup shows on the page.

### Phase 3: Yahoo adapter (OAuth 2.0)
- One-time setup: register an app at developer.yahoo.com (Fantasy Sports read scope)
- `npm run yahoo:auth`: a small CLI that opens the consent URL, catches the redirect (HTTPS on localhost with a self-signed cert, or a manual paste-the-code fallback), and saves tokens to `.tokens/yahoo.json`
- Refresh the access token automatically when it's within 5 minutes of its 1h expiry
- `GET /fantasy/v2/league/nfl.l.{id}/scoreboard;week={n}?format=json` → find the matchup where `is_owned_by_current_login`
- Write a small helper to flatten Yahoo's numbered-key JSON
- **Done when:** my Yahoo matchup shows on the page, and it survives a token refresh.

### Phase 4: Dashboard polish
- One card per league: scores, a projection bar, and win/lose/tied coloring
- A LIVE indicator, a "last updated" time, and a visible error state per card
- Poll every 30s on Sun/Mon/Thu during game windows and every 5 min otherwise; pause when the tab is hidden
- Expandable starters list with per-player points and game status
- Mobile-friendly layout

### Phase 5 (optional): Nice-to-haves
- Deploy (Fly.io / Render / a Cloudflare Worker) so I can check it from my phone, with simple auth in front
- Score-change highlights and a "big play" flash
- Win probability (Yahoo provides it; estimate for the others)
- Browser notifications on lead changes

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| ESPN changes its unofficial endpoint | Keep all ESPN URL and shape logic in one adapter; the card shows an error and the other leagues keep working |
| ESPN cookies expire | Detect it and show "refresh espn_s2/SWID" on the card |
| Yahoo OAuth redirect URI friction | Paste-the-code fallback in the auth CLI |
| Yahoo refresh token revoked | The card shows "re-run `npm run yahoo:auth`" |
| Rate limits | 20s server cache; slow polling outside game windows |
| Each platform's scoring/projections differ | Normalized model with optional fields; the UI hides what's missing |

## What I need from you

1. League IDs for ESPN, Yahoo, and Sleeper (from each league's URL)
2. Your Sleeper username
3. Whether the ESPN league is private. If it is, `espn_s2` and `SWID` cookies from browser dev tools
4. For Phase 3: a Yahoo developer app (I'll walk you through creating it)
