# Step 2 kickoff: Sleeper adapter

Handoff from the Step 1 / 1.5 session (2026-09-27). Goal of Step 2, from [PLAN.md](../PLAN.md): the Sleeper card
shows Kevin's real teams and live points. Sleeper's API is public, so no auth is needed.

## Where things stand

> **Update:** Step 2 is done and verified against the real league. See `src/adapters/sleeper.ts`,
> `src/cache.ts` and `src/sources.ts`. The test fixtures are hand-built but checked against real response
> shapes; they're kept synthetic so the repo doesn't carry the league ID or league-mates' usernames.

| Step               | Commit    | State                      |
| ------------------ | --------- | -------------------------- |
| 1: Scaffold        | `a425ea5` | Done: mock data end to end |
| 1.5: Tooling       | `66b31e3` | Done, pushed to `main`     |
| 2: Sleeper adapter | Step 2    | Done, verified live        |

Right now `GET /api/matchups` returns three hard-coded matchups from `src/mock.ts`. The frontend
(`public/app.js`) renders any `Matchup[]` it receives.

## What exists that Step 2 builds on

| File              | What it gives you                                                                  |
| ----------------- | ---------------------------------------------------------------------------------- |
| `src/types.ts`    | `Matchup`, `TeamScore`, `PlayerLine`. The adapter's job is to return a `Matchup`.  |
| `src/config.ts`   | `SLEEPER_LEAGUE_ID` and `SLEEPER_USERNAME` are already in the schema (optional).   |
| `.env.example`    | Already lists both Sleeper vars.                                                   |
| `src/app.ts`      | The `/api/matchups` route. This is where mock data gets swapped for adapter calls. |
| `src/app.test.ts` | Route tests via `app.inject()`. Currently asserts all three platforms are present. |
| `public/app.js`   | Hides optional fields that are missing and shows `matchup.error` on the card.      |
| `.gitignore`      | `.cache/` is already ignored, ready for the players file.                          |

## Details to carry through

1. **Fault isolation is a design rule.** One league failing must never blank the others. Call adapters with
   `Promise.allSettled` and turn a rejection into a `Matchup` with `error` set, so the card shows the message.
2. **Sleeper has no projections.** `projected` stays `undefined`, and the UI already hides it. Don't invent a number.
3. **Server cache (~20s TTL per league)** is planned as `src/cache.ts`. Add it now or with ESPN, but add it before
   there's more than one real adapter, so several tabs don't multiply upstream calls.
4. **Imports use `.js`** (`./adapters/sleeper.js`). See CLAUDE.md.
5. **No `console.log`.** Pass a logger into the adapter (Fastify's `request.log` or `app.log`).
6. **Mock data retires one platform at a time.** After Step 2, `mock.ts` should only supply ESPN and Yahoo, and
   `app.test.ts` needs updating to match.

## Suggested design

```
src/adapters/sleeper.ts        # getSleeperMatchup(opts): Promise<Matchup>
src/adapters/sleeper.test.ts   # tests against saved JSON, no network
src/adapters/__fixtures__/     # trimmed real Sleeper responses
src/cache.ts                   # tiny TTL cache (Map + expiry)
```

- **HTTP:** Node's built-in `fetch`, no axios. Check `res.ok` and throw a clear error that includes the URL and
  status.
- **Validate responses with zod.** Declare only the fields we use. Zod 4 objects drop unknown keys by default, so if
  Sleeper adds fields nothing breaks, and if a field we rely on changes we get a clear error instead of `undefined`.
- **Testability:** have the adapter take its dependencies as parameters: `{ leagueId, username, fetch, log }`, with
  `fetch` defaulting to `globalThis.fetch`. Tests pass a fake `fetch` that serves fixtures. (The alternative is
  `mock.method(globalThis, "fetch")` from `node:test`, which works but is more fragile.) Explain this
  dependency-injection pattern to Kevin; it's a good lesson.
- **Unconfigured leagues:** decide with Kevin. Recommendation: skip a platform whose env vars are blank, so the page
  only shows configured leagues, and log once at startup which ones are active.

## Sleeper API notes

Base URL: `https://api.sleeper.app/v1`. No auth. Sleeper asks clients to stay under ~1000 calls/minute.

| Call                               | Use                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `GET /state/nfl`                   | Current `week`, `season`, `season_type`                           |
| `GET /league/{id}`                 | League `name`                                                     |
| `GET /league/{id}/users`           | Map `user_id` to `display_name`; find Kevin by `SLEEPER_USERNAME` |
| `GET /league/{id}/rosters`         | Map `owner_id` (a user_id) to `roster_id`                         |
| `GET /league/{id}/matchups/{week}` | Per roster: `matchup_id`, `points`, `starters`, `starters_points` |
| `GET /players/nfl`                 | ~5MB map of player_id to name/position. **At most once per day**  |

- Kevin's matchup is the other entry that shares his `matchup_id`.
- Team display name: `users[].metadata.team_name` if set, else `display_name`.
- Match `SLEEPER_USERNAME` case-insensitively. Usernames and display names can differ, so check both, or resolve it
  with `GET /user/{username}`, which returns `user_id`.
- Players file: cache to `.cache/sleeper-players.json` and refresh if older than 24h. Use `node:fs/promises`, and
  create the directory with `mkdir(..., { recursive: true })`. Keep only name and position in memory; the full
  file is large.
- **Game status (`pre`/`live`/`final`) is the hard part.** The Sleeper endpoints above don't include NFL game
  times. Start with a simple rule and flag it as a known gap: for example, `pre` if every starter has 0 points,
  otherwise `live`, and `final` after Monday night of the current week. Real game times can come later from
  ESPN's public NFL scoreboard, which the ESPN step can share.

## Needed from Kevin before coding

- **Sleeper league ID:** from `sleeper.com/leagues/<id>`
- **Sleeper username**

In a cloud session there is no `.env` (it's gitignored). Set these as environment variables in the cloud
environment's settings, or create `.env` there by hand. **Never commit them.**

Cloud environments also need `api.sleeper.app` in the network allowlist (Custom access) and
`NODE_USE_ENV_PROXY=1` as an environment variable. Outbound traffic goes through a proxy, and Node's
built-in `fetch` ignores `HTTPS_PROXY` unless that flag is set. Without it, `curl` works but the app gets
HTTP 403. Locally there's no proxy, so none of this applies.

## Setting up a new machine or cloud environment

```sh
node -v          # must be v24 (see .nvmrc); fnm/nvm: `fnm use` or `nvm use`
npm ci
npm run check    # should pass: lint, format, typecheck, 7 tests
```

## Definition of done for Step 2

- [ ] Sleeper card shows real team names and live points; ESPN and Yahoo still show mock data
- [ ] A failing Sleeper call (for example, a bad league ID) shows an error on the Sleeper card only
- [ ] Players file is cached in `.cache/` and not re-downloaded on every request
- [ ] Adapter tests run against fixtures with no network; `npm run check` passes
- [ ] PLAN.md Step 2 boxes ticked and status set to ✅; committed as `Step 2: ...`
