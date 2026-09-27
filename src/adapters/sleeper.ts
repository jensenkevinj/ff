import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { TtlCache } from "../cache.js";
import type { Matchup, MatchupStatus, PlayerLine, TeamScore } from "../types.js";

const BASE_URL = "https://api.sleeper.app/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const PLAYERS_TIMEOUT_MS = 30_000; // the players file is ~5MB
const PLAYERS_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Sleeper asks for at most one download a day
const PLAYERS_MEMORY_TTL_MS = 60 * 60 * 1000; // re-check the file's age hourly

// Schemas declare only the fields we use. Zod objects drop unknown keys, so new Sleeper fields
// don't break anything, while a missing or renamed field fails loudly instead of becoming undefined.
const stateSchema = z.object({ week: z.number().int() });
// Sleeper answers an unknown league or user with HTTP 200 and a `null` body, not a 404.
const leagueSchema = z.object({ name: z.string() }).nullable();
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
  }),
);
const rawPlayersSchema = z.record(
  z.string(),
  z.object({
    full_name: z.string().nullish(),
    first_name: z.string().nullish(), // team defenses have no full_name, just "Buffalo" + "Bills"
    last_name: z.string().nullish(),
    position: z.string().nullish(),
  }),
);
const playerInfoSchema = z.object({ name: z.string(), position: z.string() });
const playersFileSchema = z.record(z.string(), playerInfoSchema);

type PlayerInfo = z.infer<typeof playerInfoSchema>;
type Users = z.infer<typeof usersSchema>;
type SleeperMatchup = z.infer<typeof matchupsSchema>[number];

// Only what the adapter calls, so tests can pass a stub instead of a full Fastify logger.
export type Log = Pick<FastifyBaseLogger, "info" | "warn">;

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

  async function getJson<S extends z.ZodType>(
    url: string,
    schema: S,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      // AbortSignal.timeout() cancels the request if Sleeper hangs; fetch has no timeout by default.
      res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Error(`Sleeper request failed: GET ${url}: ${errorMessage(err)}`, { cause: err });
    }
    if (!res.ok) throw new Error(`Sleeper returned HTTP ${res.status} for GET ${url}`);

    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`Unexpected Sleeper response from GET ${url}:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
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
    // Keep only name and position; the full file carries dozens of fields per player.
    const trimmed: Record<string, PlayerInfo> = {};
    for (const [id, p] of Object.entries(raw)) {
      const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      trimmed[id] = { name, position: p.position ?? "" };
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
    if (age !== undefined && age < PLAYERS_FILE_MAX_AGE_MS) return readPlayersFile(playersFile);

    try {
      log.info({ playersFile }, "downloading Sleeper players file");
      return new Map(Object.entries(await downloadPlayers()));
    } catch (err) {
      if (age === undefined) throw err;
      log.warn({ err }, "Sleeper players download failed; using the stale cached file");
      return readPlayersFile(playersFile);
    }
  }

  async function getMatchup(log: Log): Promise<Matchup> {
    const { week } = await getJson(`${BASE_URL}/state/nfl`, stateSchema);

    // These don't depend on each other, so Promise.all runs them concurrently instead of one by one.
    const [leagueInfo, users, rosters, matchups, players] = await Promise.all([
      getJson(league, leagueSchema),
      getJson(`${league}/users`, usersSchema),
      getJson(`${league}/rosters`, rostersSchema),
      getJson(`${league}/matchups/${week}`, matchupsSchema),
      playersCache.getOrLoad("players", () => loadPlayers(log)),
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

    const status = matchupStatus([mine, theirs], now());
    const usersById = new Map(users.map((u) => [u.user_id, u]));
    const ownerOf = new Map(rosters.map((r) => [r.roster_id, r.owner_id]));

    function team(m: SleeperMatchup): TeamScore {
      const user = usersById.get(ownerOf.get(m.roster_id) ?? "");
      const starters = m.starters ?? [];
      return {
        name: user?.metadata?.team_name || user?.display_name || `Team ${m.roster_id}`,
        owner: user?.display_name,
        points: m.points ?? 0,
        // No `projected` or `playersRemaining`: Sleeper doesn't provide projections, and without
        // game times we can't tell "hasn't played" from "played and scored 0".
        starters: starters.map((id, i) => starterLine(id, m.starters_points?.[i] ?? 0, status, players)),
      };
    }

    return {
      platform: "sleeper",
      leagueName: leagueInfo.name,
      week,
      status,
      updatedAt: now().toISOString(),
      me: team(mine),
      opponent: team(theirs),
    };
  }

  return { getMatchup };
}

function starterLine(
  id: string,
  points: number,
  status: MatchupStatus,
  players: Map<string, PlayerInfo>,
): PlayerLine {
  // Sleeper fills empty lineup slots with "0".
  const info = id === "0" ? { name: "Empty", position: "" } : (players.get(id) ?? { name: id, position: "" });
  return { ...info, points, status: status === "final" ? "done" : points !== 0 ? "live" : "pre" };
}

// Known gap: these Sleeper endpoints don't include NFL game times, so this is a heuristic.
// No starter has scored → "pre". Tuesday or Wednesday (US Eastern), after Monday night's game → "final".
// Otherwise → "live", even between game windows. Real game times can come from ESPN's NFL scoreboard later.
export function matchupStatus(matchups: SleeperMatchup[], at: Date): MatchupStatus {
  const anyPoints = matchups.some((m) => (m.starters_points ?? []).some((p) => p !== 0));
  if (!anyPoints) return "pre";
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(
    at,
  );
  return weekday === "Tue" || weekday === "Wed" ? "final" : "live";
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

// fetch's own errors are vague ("fetch failed"); the useful detail (DNS, refused, timeout) is in `cause`.
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}
