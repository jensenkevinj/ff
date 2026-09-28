import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TtlCache } from "../cache.js";
import { errorMessage, fetchJson } from "../http.js";
import type { Log } from "../log.js";
import { fetchNflGameStates, type GameState, type NflGameStates } from "../nfl-scoreboard.js";
import { mapStats, statLine, type StatKey, type Stats } from "../stats.js";
import type { Matchup, MatchupStatus, PlayerLine, TeamScore } from "../types.js";
import { teamTotal, winProbability, type PlayerOutlook } from "../win-probability.js";

const BASE_URL = "https://api.sleeper.app/v1";
// Box scores and projections live on Sleeper's undocumented (but public) API host, not the documented v1 API.
const STATS_URL = "https://api.sleeper.com/stats/nfl";
const PROJECTIONS_URL = "https://api.sleeper.com/projections/nfl";
const PROJECTIONS_TTL_MS = 10 * 60 * 1000; // ~2MB, and projections barely move during a game
// Positions we show stat lines for. Filtering server-side shrinks the reply from ~1.9MB to ~0.7MB.
const STATS_POSITIONS = ["QB", "RB", "WR", "TE", "FB", "K", "DEF"];
const STAT_NAMES: Record<StatKey, string> = {
  passCmp: "pass_cmp",
  passAtt: "pass_att",
  passYd: "pass_yd",
  passTd: "pass_td",
  passInt: "pass_int",
  rushAtt: "rush_att",
  rushYd: "rush_yd",
  rushTd: "rush_td",
  rec: "rec",
  recYd: "rec_yd",
  recTd: "rec_td",
  fumLost: "fum_lost",
  fgm: "fgm",
  fga: "fga",
  xpm: "xpm",
  xpa: "xpa",
  defSack: "sack",
  defInt: "int",
  defFumRec: "fum_rec",
  ptsAllowed: "pts_allow",
};
const REQUEST_TIMEOUT_MS = 10_000;
const PLAYERS_TIMEOUT_MS = 30_000; // the players file is ~5MB
const PLAYERS_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Sleeper asks for at most one download a day
const PLAYERS_MEMORY_TTL_MS = 60 * 60 * 1000; // re-check the file's age hourly
// Sleeper team abbreviations that differ from ESPN's scoreboard (which we use for game states).
const ESPN_TEAM: Record<string, string> = { WAS: "WSH" };

// Schemas declare only the fields we use. Zod objects drop unknown keys, so new Sleeper fields
// don't break anything, while a missing or renamed field fails loudly instead of becoming undefined.
const stateSchema = z.object({ week: z.number().int(), season: z.string(), season_type: z.string() });
// Sleeper answers an unknown league or user with HTTP 200 and a `null` body, not a 404.
const leagueSchema = z
  .object({
    name: z.string(),
    // Points per stat, e.g. { pass_td: 4, rec: 0.5 }; applied to projected stats to get projected points.
    scoring_settings: z.record(z.string(), z.number()).nullish(),
  })
  .nullable();
const lookupUserSchema = z.object({ user_id: z.string() }).nullable();
const usersSchema = z.array(
  z.object({
    user_id: z.string(),
    display_name: z.string(),
    metadata: z.object({ team_name: z.string().nullish() }).nullish(),
  }),
);
const rostersSchema = z.array(z.object({ roster_id: z.number().int(), owner_id: z.string().nullish() }));
const matchupsSchema = z.array(
  z.object({
    roster_id: z.number().int(),
    matchup_id: z.number().int().nullish(), // null during bye weeks and the offseason
    points: z.number().nullish(),
    starters: z.array(z.string()).nullish(),
    starters_points: z.array(z.number()).nullish(),
    players: z.array(z.string()).nullish(), // the whole roster: starters, bench and reserve
    players_points: z.record(z.string(), z.number()).nullish(), // keyed by player ID
  }),
);
const statsSchema = z.array(
  z.object({
    player_id: z.string(), // team abbreviation ("BUF") for defenses, same as in matchups
    stats: z.record(z.string(), z.number().nullish()),
  }),
);
const rawPlayersSchema = z.record(
  z.string(),
  z.object({
    full_name: z.string().nullish(),
    first_name: z.string().nullish(), // team defenses have no full_name, just "Buffalo" + "Bills"
    last_name: z.string().nullish(),
    position: z.string().nullish(),
    team: z.string().nullish(), // null for free agents
  }),
);
// `team` is required (though nullable): a players file cached before it was added fails this schema
// and gets downloaded again.
const playerInfoSchema = z.object({ name: z.string(), position: z.string(), team: z.string().nullable() });
const playersFileSchema = z.record(z.string(), playerInfoSchema);

type PlayerInfo = z.infer<typeof playerInfoSchema>;
type Users = z.infer<typeof usersSchema>;
type SleeperMatchup = z.infer<typeof matchupsSchema>[number];

export type SleeperOptions = {
  leagueId: string;
  username: string;
  /** Where to cache the trimmed players file, e.g. `.cache/sleeper-players.json`. */
  playersFile: string;
  // Dependencies are parameters with real defaults, so tests can swap in fakes without patching globals.
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export function createSleeperAdapter(opts: SleeperOptions) {
  const { leagueId, username, playersFile } = opts;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  const league = `${BASE_URL}/league/${encodeURIComponent(leagueId)}`;
  const playersCache = new TtlCache<Map<string, PlayerInfo>>(PLAYERS_MEMORY_TTL_MS, () => now().getTime());
  type RawStats = z.infer<typeof statsSchema>;
  const projectionsCache = new TtlCache<RawStats>(PROJECTIONS_TTL_MS, () => now().getTime());

  function getJson<S extends z.ZodType>(url: string, schema: S, timeoutMs = REQUEST_TIMEOUT_MS) {
    return fetchJson(url, schema, { service: "Sleeper", fetch: fetchFn, timeoutMs });
  }

  // Usernames and display names can differ, so try the league's display names first and fall
  // back to resolving the username to a user_id.
  async function findUserId(users: Users): Promise<string> {
    const wanted = username.toLowerCase();
    const byDisplayName = users.find((u) => u.display_name.toLowerCase() === wanted);
    if (byDisplayName) return byDisplayName.user_id;

    const user = await getJson(`${BASE_URL}/user/${encodeURIComponent(username)}`, lookupUserSchema);
    if (!user) throw new Error(`Sleeper user "${username}" not found`);
    return user.user_id;
  }

  async function downloadPlayers(): Promise<Record<string, PlayerInfo>> {
    const raw = await getJson(`${BASE_URL}/players/nfl`, rawPlayersSchema, PLAYERS_TIMEOUT_MS);
    // Keep only name, position and team; the full file carries dozens of fields per player.
    const trimmed: Record<string, PlayerInfo> = {};
    for (const [id, p] of Object.entries(raw)) {
      const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      trimmed[id] = { name, position: p.position ?? "", team: p.team ?? null };
    }
    await mkdir(path.dirname(playersFile), { recursive: true });
    // Write to a temp file and rename: rename is atomic, so a crash mid-write never leaves a
    // half-written file for the next run to choke on.
    const tmp = `${playersFile}.tmp`;
    await writeFile(tmp, JSON.stringify(trimmed));
    await rename(tmp, playersFile);
    return trimmed;
  }

  async function loadPlayers(log: Log): Promise<Map<string, PlayerInfo>> {
    const age = await fileAgeMs(playersFile, now());
    if (age !== undefined && age < PLAYERS_FILE_MAX_AGE_MS) {
      try {
        return await readPlayersFile(playersFile);
      } catch (err) {
        // An old format or a corrupt file: fetching a new one fixes both.
        log.warn(
          { err: errorMessage(err) },
          "cached Sleeper players file is unreadable; downloading it again",
        );
      }
    }

    try {
      log.info({ playersFile }, "downloading Sleeper players file");
      return new Map(Object.entries(await downloadPlayers()));
    } catch (err) {
      if (age === undefined) throw err;
      log.warn({ err }, "Sleeper players download failed; using the stale cached file");
      return readPlayersFile(playersFile);
    }
  }

  // Stat lines are a nice-to-have: if this undocumented endpoint fails, show the card without them.
  function statsQuery(state: z.infer<typeof stateSchema>) {
    const query = new URLSearchParams({ season_type: state.season_type });
    for (const p of STATS_POSITIONS) query.append("position[]", p);
    return `${state.season}/${state.week}?${query}`;
  }

  async function loadStats(state: z.infer<typeof stateSchema>, log: Log): Promise<Map<string, Stats>> {
    try {
      const rows = await getJson(`${STATS_URL}/${statsQuery(state)}`, statsSchema);
      return new Map(rows.map((r) => [r.player_id, mapStats(r.stats, STAT_NAMES)]));
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "Sleeper stats unavailable; showing players without stat lines");
      return new Map();
    }
  }

  // Projected stats per player (raw, before this league's scoring). Optional like the stats: without them
  // the card just has no projections or win probability.
  async function loadProjections(state: z.infer<typeof stateSchema>, log: Log): Promise<RawStats> {
    try {
      const key = statsQuery(state);
      return await projectionsCache.getOrLoad(key, () => getJson(`${PROJECTIONS_URL}/${key}`, statsSchema));
    } catch (err) {
      log.warn(
        { err: errorMessage(err) },
        "Sleeper projections unavailable; no projections or win probability",
      );
      return [];
    }
  }

  // Game states are a nice-to-have too: without them, fall back to guessing from points and the weekday.
  async function loadGameStates(season: string, week: number, log: Log): Promise<NflGameStates | undefined> {
    try {
      return await fetchNflGameStates({ season: Number(season), week, fetch: fetchFn });
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "NFL scoreboard unavailable; guessing Sleeper game status");
      return undefined;
    }
  }

  async function getMatchup(log: Log): Promise<Matchup> {
    const state = await getJson(`${BASE_URL}/state/nfl`, stateSchema);
    const { week } = state;

    // These don't depend on each other, so Promise.all runs them concurrently instead of one by one.
    const [leagueInfo, users, rosters, matchups, players, stats, games, projectionRows] = await Promise.all([
      getJson(league, leagueSchema),
      getJson(`${league}/users`, usersSchema),
      getJson(`${league}/rosters`, rostersSchema),
      getJson(`${league}/matchups/${week}`, matchupsSchema),
      playersCache.getOrLoad("players", () => loadPlayers(log)),
      loadStats(state, log),
      loadGameStates(state.season, week, log),
      loadProjections(state, log),
    ]);
    if (!leagueInfo) throw new Error(`Sleeper league ${leagueId} not found`);

    const userId = await findUserId(users);
    const myRoster = rosters.find((r) => r.owner_id === userId);
    if (!myRoster) throw new Error(`"${username}" has no team in ${leagueInfo.name}`);

    const mine = matchups.find((m) => m.roster_id === myRoster.roster_id);
    if (mine?.matchup_id == null)
      throw new Error(`No Sleeper matchup in week ${week} (bye week or offseason)`);
    const theirs = matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id);
    if (!theirs) throw new Error(`No opponent found for week ${week}`);

    // Starters' NFL teams, for the matchup status. Empty slots ("0") have no team.
    const starterTeams = [mine, theirs].flatMap((m) =>
      (m.starters ?? []).map((id) => players.get(id)?.team ?? null),
    );
    const status = games
      ? matchupStatus(starterTeams, games.byAbbreviation)
      : guessMatchupStatus([mine, theirs], now());
    const scoring = leagueInfo.scoring_settings;
    const projected = new Map(
      scoring ? projectionRows.map((r) => [r.player_id, round(applyScoring(r.stats, scoring))]) : [],
    );
    const usersById = new Map(users.map((u) => [u.user_id, u]));
    const ownerOf = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));

    const line = (id: string, points: number): PlayerLine => {
      // Sleeper fills empty lineup slots with "0".
      const info = id === "0" ? { name: "Empty", position: "", team: null } : players.get(id);
      const { name, position } = info ?? { name: id, position: "" };
      const result: PlayerLine = {
        name,
        position,
        points,
        // Without the scoreboard, every player gets the matchup-wide guess.
        status: games
          ? playerStatus(info?.team ?? null, games.byAbbreviation)
          : guessPlayerStatus(status, points),
      };
      const proj = projected.get(id);
      if (proj !== undefined) result.projected = proj;
      const box = statLine(position, stats.get(id));
      if (box) result.statLine = box;
      return result;
    };

    function team(m: SleeperMatchup): TeamScore & { outlook?: ReturnType<typeof teamTotal> } {
      const user = usersById.get(ownerOf.get(m.roster_id) ?? "");
      const starters = m.starters ?? [];
      // A Set makes each "is this a starter?" check O(1) instead of scanning the array.
      const starterIds = new Set(starters);
      const bench = (m.players ?? []).filter((id) => !starterIds.has(id));
      const lines = starters.map((id, i) => line(id, m.starters_points?.[i] ?? 0));
      // Expected final score and its uncertainty; needs both the scoreboard (how much of each game is
      // left) and projections.
      const outlook =
        games && projected.size > 0
          ? teamTotal(
              starters.map((id, i) => ({
                points: m.starters_points?.[i] ?? 0,
                projected: projected.get(id) ?? 0,
                fractionLeft: gameFractionLeft(players.get(id)?.team ?? null, games),
              })),
            )
          : undefined;
      return {
        name: user?.metadata?.team_name || user?.display_name || `Team ${m.roster_id}`,
        owner: user?.display_name,
        points: m.points ?? 0,
        projected: round(outlook?.mean),
        // "Left" means not started or mid-game, which only the scoreboard can tell apart from
        // "played and scored 0".
        playersRemaining: games ? lines.filter((p) => p.status !== "done").length : undefined,
        starters: lines,
        bench: bench.map((id) => line(id, m.players_points?.[id] ?? 0)),
        outlook,
      };
    }

    // `outlook` is only needed here, so it's split off rather than sent to the browser.
    const { outlook: myOutlook, ...me } = team(mine);
    const { outlook: theirOutlook, ...opponent } = team(theirs);
    if (myOutlook && theirOutlook) {
      me.winProbability = winProbability(myOutlook, theirOutlook);
      opponent.winProbability = 1 - me.winProbability;
    }
    return {
      platform: "sleeper",
      leagueName: leagueInfo.name,
      week,
      status,
      updatedAt: now().toISOString(),
      me,
      opponent,
    };
  }

  return { getMatchup };
}

function gameFractionLeft(team: string | null, games: NflGameStates): PlayerOutlook["fractionLeft"] {
  // No game this week (a bye, a free agent, an empty slot): nothing left to score.
  return team === null ? 0 : (games.fractionLeft.get(ESPN_TEAM[team] ?? team) ?? 0);
}

// Projected points for this league: each projected stat times what the league pays for it.
function applyScoring(stats: Record<string, number | null | undefined>, scoring: Record<string, number>) {
  let points = 0;
  for (const [stat, value] of Object.entries(stats)) points += (value ?? 0) * (scoring[stat] ?? 0);
  return points;
}

function round(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 100) / 100;
}

function playerStatus(team: string | null, games: Map<string, GameState>): PlayerLine["status"] {
  // Not on this week's scoreboard (a bye, a free agent, an empty slot): nothing left to play.
  const state = team === null ? undefined : games.get(ESPN_TEAM[team] ?? team);
  if (state === undefined || state === "post") return "done";
  return state === "in" ? "live" : "pre";
}

// Only starters with a game this week count: a bye or an empty slot would otherwise read as
// "done" and turn a not-yet-started matchup into "live".
function matchupStatus(teams: (string | null)[], games: Map<string, GameState>): MatchupStatus {
  const states = teams.flatMap((team) => {
    const state = team === null ? undefined : games.get(ESPN_TEAM[team] ?? team);
    return state === undefined ? [] : [state];
  });
  if (states.every((s) => s === "pre")) return "pre";
  if (states.every((s) => s === "post")) return "final";
  return "live"; // mid-game, or between game windows with games still to come
}

// Fallback when the NFL scoreboard is down. Sleeper's own endpoints have no game times, so this guesses:
// no starter has scored → "pre"; Tuesday or Wednesday (US Eastern), after Monday night's game → "final";
// otherwise "live", even between game windows.
export function guessMatchupStatus(matchups: SleeperMatchup[], at: Date): MatchupStatus {
  const anyPoints = matchups.some((m) => (m.starters_points ?? []).some((p) => p !== 0));
  if (!anyPoints) return "pre";
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(
    at,
  );
  return weekday === "Tue" || weekday === "Wed" ? "final" : "live";
}

function guessPlayerStatus(matchup: MatchupStatus, points: number): PlayerLine["status"] {
  return matchup === "final" ? "done" : points !== 0 ? "live" : "pre";
}

async function fileAgeMs(file: string, at: Date): Promise<number | undefined> {
  try {
    return at.getTime() - (await stat(file)).mtimeMs;
  } catch (err) {
    // Node reports "file doesn't exist" as an error with code ENOENT; anything else is a real problem.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function readPlayersFile(file: string): Promise<Map<string, PlayerInfo>> {
  const data = playersFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return new Map(Object.entries(data));
}
