import { z } from "zod";
import { errorMessage, fetchJson, HttpError } from "../http.js";
import { fetchNflGameStates, type GameState } from "../nfl-scoreboard.js";
import type { Matchup, MatchupStatus, PlayerLine, TeamScore } from "../types.js";
import type { Log } from "../log.js";

// ESPN's fantasy API is unofficial and undocumented; everything ESPN-specific stays in this file so a
// change on their side breaks only the ESPN card.
const BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// Lineup slot and position IDs are ESPN's own numbering.
const BENCH_SLOT = 20;
const IR_SLOT = 21;
// Display order for starters: QB, RB, WR, TE, FLEX, OP (superflex), D/ST, K. Unknown slots go last.
const SLOT_ORDER = [0, 2, 4, 6, 23, 7, 16, 17];
const POSITIONS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const ACTUAL = 0; // statSourceId: real stats
const PROJECTED = 1; // statSourceId: ESPN projections
const SINGLE_WEEK = 1; // statSplitTypeId: one scoring period, not season totals

const statSchema = z.object({
  scoringPeriodId: z.number().int(),
  statSourceId: z.number().int(),
  statSplitTypeId: z.number().int(),
  appliedTotal: z.number(),
});
const sideSchema = z.object({
  teamId: z.number().int(),
  totalPoints: z.number(),
  totalPointsLive: z.number().nullish(),
  totalProjectedPointsLive: z.number().nullish(),
  rosterForCurrentScoringPeriod: z
    .object({
      entries: z.array(
        z.object({
          lineupSlotId: z.number().int(),
          playerPoolEntry: z.object({
            player: z.object({
              fullName: z.string(),
              defaultPositionId: z.number().int(),
              proTeamId: z.number().int(), // 0 = free agent
              stats: z.array(statSchema).nullish(),
            }),
          }),
        }),
      ),
    })
    .nullish(),
});
const leagueSchema = z.object({
  scoringPeriodId: z.number().int(),
  settings: z.object({ name: z.string() }),
  members: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullish(),
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
    }),
  ),
  teams: z.array(
    z.object({
      id: z.number().int(),
      name: z.string().nullish(),
      location: z.string().nullish(), // older leagues split the name into location + nickname
      nickname: z.string().nullish(),
      owners: z.array(z.string()).nullish(),
    }),
  ),
  schedule: z.array(
    z.object({
      matchupPeriodId: z.number().int(),
      winner: z.string().nullish(), // "HOME" | "AWAY" | "TIE" once final, "UNDECIDED" before
      home: sideSchema,
      away: sideSchema.nullish(), // missing on a bye
    }),
  ),
});

type League = z.infer<typeof leagueSchema>;
type Side = z.infer<typeof sideSchema>;
type Entry = NonNullable<Side["rosterForCurrentScoringPeriod"]>["entries"][number];
type PlayerStatus = PlayerLine["status"];

export type EspnOptions = {
  leagueId: string;
  season: number;
  /** Your team's ID. Required for public leagues, where there's no SWID cookie to match on. */
  teamId?: number;
  /** Cookies for private leagues, copied from a logged-in browser. */
  espnS2?: string;
  swid?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export function createEspnAdapter(opts: EspnOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  const views = ["mTeam", "mSettings", "mMatchupScore", "mScoreboard"].map((v) => `view=${v}`).join("&");
  const url = `${BASE_URL}/${opts.season}/segments/0/leagues/${encodeURIComponent(opts.leagueId)}?${views}`;

  const headers: Record<string, string> = {
    // Without this filter the response carries the whole season's schedule (~3.4MB instead of ~0.5MB).
    "X-Fantasy-Filter": JSON.stringify({ schedule: { filterCurrentMatchupPeriod: { value: true } } }),
  };
  if (opts.espnS2 && opts.swid) headers.Cookie = `espn_s2=${opts.espnS2}; SWID=${opts.swid}`;

  async function fetchLeague(): Promise<League> {
    try {
      return await fetchJson(url, leagueSchema, { service: "ESPN", fetch: fetchFn, headers });
    } catch (err) {
      // ESPN answers 401 for private leagues, expired cookies, and league IDs that don't exist.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        const hint = opts.espnS2
          ? "Your ESPN_S2/ESPN_SWID cookies may have expired; copy fresh ones from espn.com."
          : "If the league is private, set ESPN_S2 and ESPN_SWID. Also check ESPN_LEAGUE_ID and ESPN_SEASON.";
        throw new Error(`ESPN denied access to league ${opts.leagueId} (HTTP ${err.status}). ${hint}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  function findMyTeamId(league: League): number {
    if (opts.teamId !== undefined) return opts.teamId;
    // SWID is a GUID in braces, and ESPN isn't consistent about letter case.
    const swid = opts.swid?.toUpperCase();
    const team = swid && league.teams.find((t) => t.owners?.some((o) => o.toUpperCase() === swid));
    if (team) return team.id;
    throw new Error(
      "Can't tell which ESPN team is yours: set ESPN_TEAM_ID (or ESPN_SWID for a private league)",
    );
  }

  async function getMatchup(log: Log): Promise<Matchup> {
    const league = await fetchLeague();
    const week = league.scoringPeriodId;
    const myTeamId = findMyTeamId(league);

    const game = league.schedule.find((m) => m.home.teamId === myTeamId || m.away?.teamId === myTeamId);
    if (!game) throw new Error(`No ESPN matchup for team ${myTeamId} in week ${week}`);
    if (!game.away) throw new Error(`Bye week: team ${myTeamId} has no opponent in week ${week}`);
    const [mine, theirs] = game.home.teamId === myTeamId ? [game.home, game.away] : [game.away, game.home];

    // Game states are a nice-to-have: if the scoreboard is down, fall back to guessing from points
    // rather than failing the whole card.
    let games: Map<number, GameState> | undefined;
    try {
      games = await fetchNflGameStates({ season: opts.season, week, fetch: fetchFn });
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "NFL scoreboard unavailable; guessing game status from points");
    }

    const me = team(league, mine, week, games);
    const opponent = team(league, theirs, week, games);
    return {
      platform: "espn",
      leagueName: league.settings.name,
      week,
      status: matchupStatus(game.winner, [...(me.starters ?? []), ...(opponent.starters ?? [])]),
      updatedAt: now().toISOString(),
      me,
      opponent,
    };
  }

  return { getMatchup };
}

function team(
  league: League,
  side: Side,
  week: number,
  games: Map<number, GameState> | undefined,
): TeamScore {
  const info = league.teams.find((t) => t.id === side.teamId);
  const owner = league.members.find((m) => m.id === info?.owners?.[0]);

  const entries = side.rosterForCurrentScoringPeriod?.entries ?? [];
  const onBench = (e: Entry) => e.lineupSlotId === BENCH_SLOT || e.lineupSlotId === IR_SLOT;
  const line = ({ playerPoolEntry: { player } }: Entry): PlayerLine => {
    const points = weekStat(player.stats, week, ACTUAL) ?? 0;
    return {
      name: player.fullName,
      position: POSITIONS[player.defaultPositionId] ?? "",
      points,
      projected: round(weekStat(player.stats, week, PROJECTED)),
      status: playerStatus(player.proTeamId, points, games),
    };
  };
  const starters = entries
    .filter((e) => !onBench(e))
    .sort((a, b) => slotRank(a.lineupSlotId) - slotRank(b.lineupSlotId))
    .map(line);

  return {
    name: info?.name || [info?.location, info?.nickname].filter(Boolean).join(" ") || `Team ${side.teamId}`,
    owner:
      [owner?.firstName?.trim(), owner?.lastName?.trim()].filter(Boolean).join(" ") ||
      owner?.displayName ||
      undefined,
    // totalPoints only fills in once the week is final; totalPointsLive is the running score.
    points: round(side.totalPointsLive ?? side.totalPoints) ?? 0,
    projected: round(side.totalProjectedPointsLive),
    // "Left" means still has points to add: not started yet, or mid-game.
    playersRemaining: games ? starters.filter((p) => p.status !== "done").length : undefined,
    starters,
    bench: entries.filter(onBench).map(line),
  };
}

function weekStat(stats: z.infer<typeof statSchema>[] | null | undefined, week: number, source: number) {
  return stats?.find(
    (s) => s.scoringPeriodId === week && s.statSourceId === source && s.statSplitTypeId === SINGLE_WEEK,
  )?.appliedTotal;
}

function playerStatus(
  proTeamId: number,
  points: number,
  games: Map<number, GameState> | undefined,
): PlayerStatus {
  if (!games) return points !== 0 ? "live" : "pre";
  const state = games.get(proTeamId);
  // Not on this week's scoreboard: a bye week or a free agent, so there's nothing left to play.
  if (state === undefined || state === "post") return "done";
  return state === "in" ? "live" : "pre";
}

function matchupStatus(winner: string | null | undefined, starters: PlayerLine[]): MatchupStatus {
  if (winner && winner !== "UNDECIDED") return "final";
  if (starters.length > 0 && starters.every((p) => p.status === "done")) return "final";
  if (starters.every((p) => p.status === "pre")) return "pre";
  return "live";
}

function slotRank(slot: number): number {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
}

// ESPN sends floats like 114.28035412; keep two decimals.
function round(n: number | null | undefined): number | undefined {
  return n == null ? undefined : Math.round(n * 100) / 100;
}
