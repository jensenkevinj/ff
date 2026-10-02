import { z } from "zod";
import { TtlCache } from "../cache.js";
import { errorMessage, fetchJson, HttpError } from "../http.js";
import { espnAbbreviation, fetchNflGames, type NflGame } from "../nfl-scoreboard.js";
import { lineupAlerts } from "../lineup-alerts.js";
import { statLine, type Stats } from "../stats.js";
import type { InjuryStatus, Matchup, MatchupStatus, PlayerLine, TeamRecord, TeamScore } from "../types.js";
import type { Log } from "../log.js";
import { REAUTH_HINT } from "./yahoo-auth.js";
import { flatten, listOf } from "./yahoo-json.js";

const BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
const STANDINGS_TTL_MS = 5 * 60 * 1000; // records change once a week
const SETTINGS_TTL_MS = 60 * 60 * 1000; // roster slots change once a season

// Lineup slots that don't count toward the score. Everything else is a starting slot.
const BENCH_SLOTS = new Set(["BN", "IR", "IR+", "NA"]);
// Display order for starters; flex-type slots after the fixed positions, unknown ones last.
const SLOT_ORDER = ["QB", "RB", "WR", "TE", "W/R/T", "W/R", "W/T", "Q/W/R/T", "K", "DEF"];
// Yahoo's `status` on a player. Anything not listed (healthy, "NA") shows no badge.
const INJURIES: Record<string, InjuryStatus> = {
  Q: "Q",
  D: "D",
  DTD: "DTD",
  O: "O",
  IR: "IR",
  "IR-R": "IR",
  "IR-PUP": "IR",
  "PUP-R": "PUP",
  "PUP-P": "PUP",
  SUSP: "SUS",
};

// Yahoo's numeric stat IDs. Only the stats a league scores come back, so any of these may be absent.
const STAT = {
  passAtt: "1",
  passCmp: "2",
  passYd: "4",
  passTd: "5",
  passInt: "6",
  rushAtt: "8",
  rushYd: "9",
  rushTd: "10",
  rec: "11",
  recYd: "12",
  recTd: "13",
  fumLost: "18",
  xpMade: "29",
  xpMiss: "30",
  ptsAllowed: "31",
  defSack: "32",
  defInt: "33",
  defFumRec: "34",
} as const;
// Field goals are scored by distance: IDs 19–23 are makes, 24–28 are misses.
const FG_MADE = ["19", "20", "21", "22", "23"];
const FG_MISSED = ["24", "25", "26", "27", "28"];

// Yahoo sends many numbers as strings ("14.00", "4"), so numeric fields are coerced.
const num = z.coerce.number();

// Schemas describe the response *after* `flatten` (see yahoo-json.ts) and declare only the fields we use.
const teamSchema = z.object({
  team_key: z.string(),
  name: z.string(),
  is_owned_by_current_login: num.optional(), // 1 on the signed-in user's team
  managers: z.preprocess(
    listOf,
    z.array(z.object({ manager: z.object({ nickname: z.string().nullish() }) })),
  ),
  win_probability: num.nullish(), // 0–1
  team_points: z.object({ total: num }),
  team_projected_points: z.object({ total: num }).nullish(),
});
const scoreboardSchema = z.object({
  fantasy_content: z.object({
    league: z.object({
      name: z.string(),
      season: num,
      scoreboard: z.object({
        week: num,
        // Yahoo nests the matchup list one level down, under the key "0".
        "0": z.object({
          matchups: z.array(
            z.object({
              matchup: z.object({
                status: z.string(), // "preevent" | "midevent" | "postevent"
                "0": z.object({ teams: z.array(z.object({ team: teamSchema })) }),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const playerSchema = z.object({
  player: z.object({
    name: z.object({ full: z.string() }),
    editorial_team_abbr: z.string().nullish(), // "Det", "LV"; ESPN spells a few differently
    primary_position: z.string(),
    status: z.string().nullish(), // injury designation, only when there is one
    selected_position: z.object({ position: z.string() }), // lineup slot: "QB", "W/R/T", "BN", "IR", …
    player_points: z.object({ total: num }).nullish(),
    player_stats: z
      .object({
        stats: z.preprocess(
          listOf,
          z.array(
            z.object({
              stat: z.object({ stat_id: z.coerce.string(), value: z.union([z.number(), z.string()]) }),
            }),
          ),
        ),
      })
      .nullish(),
  }),
});
const rosterSchema = z.object({
  fantasy_content: z.object({
    team: z.object({ roster: z.object({ "0": z.object({ players: z.array(playerSchema) }) }) }),
  }),
});

const standingsSchema = z.object({
  fantasy_content: z.object({
    league: z.object({
      standings: z.object({
        teams: z.array(
          z.object({
            team: z.object({
              team_key: z.string(),
              team_standings: z.object({
                rank: num,
                outcome_totals: z.object({ wins: num, losses: num, ties: num.default(0) }),
              }),
            }),
          }),
        ),
      }),
    }),
  }),
});

const settingsSchema = z.object({
  fantasy_content: z.object({
    league: z.object({
      settings: z.object({
        roster_positions: z.preprocess(
          listOf,
          z.array(z.object({ roster_position: z.object({ count: num, is_starting_position: num }) })),
        ),
      }),
    }),
  }),
});

type Team = z.infer<typeof teamSchema>;
type Player = z.infer<typeof playerSchema>["player"];

export type YahooOptions = {
  /** The number in your league's URL: football.fantasysports.yahoo.com/f1/<id>. */
  leagueId: string;
  /** From `createYahooAuth`; hands out a valid access token, refreshing it when needed. */
  auth: { getAccessToken: () => Promise<string> };
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

export function createYahooAdapter(opts: YahooOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  // `nfl` stands for the current season's NFL game, so the league key needs no season.
  const leagueKey = `nfl.l.${opts.leagueId}`;
  const standingsCache = new TtlCache<Map<string, TeamRecord>>(STANDINGS_TTL_MS, () => now().getTime());
  const settingsCache = new TtlCache<number>(SETTINGS_TTL_MS, () => now().getTime());

  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    const token = await opts.auth.getAccessToken();
    try {
      return await fetchJson(`${BASE_URL}${path}?format=json`, z.preprocess(flatten, schema), {
        service: "Yahoo",
        fetch: fetchFn,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        throw new Error(`Yahoo rejected the access token: ${REAUTH_HINT}`, { cause: err });
      }
      if (err instanceof HttpError && err.status === 403) {
        throw new Error(
          `Yahoo denied access to league ${opts.leagueId} (HTTP 403). Check YAHOO_LEAGUE_ID, that you're signed in ` +
            `as a member (${REAUTH_HINT}), and that Yahoo has approved your app for the Fantasy API.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  const getRoster = async (teamKey: string, week: number) =>
    (
      await get(`/team/${teamKey}/roster;week=${week}/players/stats;type=week;week=${week}`, rosterSchema)
    ).fantasy_content.team.roster["0"].players.map((p) => p.player);

  // Decoration, like ESPN's records: if these calls fail, the card loses the record or the empty-slot
  // alert instead of failing outright.
  async function getRecords(log: Log): Promise<Map<string, TeamRecord> | undefined> {
    try {
      return await standingsCache.getOrLoad("standings", async () => {
        const data = await get(`/league/${leagueKey}/standings`, standingsSchema);
        return new Map(
          data.fantasy_content.league.standings.teams.map(({ team }) => {
            const { rank, outcome_totals: t } = team.team_standings;
            // Rank is 0 or blank before any game has been played.
            return [team.team_key, { ...t, rank: rank > 0 ? rank : undefined }];
          }),
        );
      });
    } catch (err) {
      log.warn({ err: errorMessage(err) }, "Yahoo standings unavailable; showing no records");
      return undefined;
    }
  }

  async function getStartingSlots(log: Log): Promise<number | undefined> {
    try {
      return await settingsCache.getOrLoad("slots", async () => {
        const data = await get(`/league/${leagueKey}/settings`, settingsSchema);
        return data.fantasy_content.league.settings.roster_positions
          .filter((r) => r.roster_position.is_starting_position === 1)
          .reduce((sum, r) => sum + r.roster_position.count, 0);
      });
    } catch (err) {
      log.warn(
        { err: errorMessage(err) },
        "Yahoo league settings unavailable; skipping the empty-slot check",
      );
      return undefined;
    }
  }

  async function getMatchup(log: Log): Promise<Matchup> {
    const { league } = (await get(`/league/${leagueKey}/scoreboard`, scoreboardSchema)).fantasy_content;
    const week = league.scoreboard.week;

    const matchup = league.scoreboard["0"].matchups
      .map((m) => m.matchup)
      .find((m) => m["0"].teams.some((t) => t.team.is_owned_by_current_login === 1));
    if (!matchup) {
      throw new Error(
        `No Yahoo matchup for your team in week ${week} (bye week, or you're not a manager in league ${opts.leagueId})`,
      );
    }
    const [mine, theirs] = orderMine(matchup["0"].teams.map((t) => t.team));

    // Game states are a nice-to-have: without the scoreboard we guess from points, as the ESPN adapter does.
    const gamesPromise = fetchNflGames({ season: league.season, week, fetch: fetchFn }).then(
      (g) => g.byAbbreviation,
      (err: unknown) => {
        log.warn({ err: errorMessage(err) }, "NFL scoreboard unavailable; guessing game status from points");
        return undefined;
      },
    );
    const [myPlayers, theirPlayers, games, records, startingSlots] = await Promise.all([
      getRoster(mine.team_key, week),
      getRoster(theirs.team_key, week),
      gamesPromise,
      getRecords(log),
      getStartingSlots(log),
    ]);

    const me = buildTeam(mine, myPlayers, games, records, startingSlots);
    const opponent = buildTeam(theirs, theirPlayers, games, records, undefined);
    return {
      platform: "yahoo",
      leagueName: league.name,
      week,
      status: matchupStatus(matchup.status, [...(me.starters ?? []), ...(opponent.starters ?? [])]),
      updatedAt: now().toISOString(),
      me,
      opponent,
    };
  }

  return { getMatchup };
}

function orderMine(teams: Team[]): [Team, Team] {
  const [a, b] = teams;
  if (!a || !b) throw new Error("Yahoo matchup doesn't have two teams (bye week?)");
  return a.is_owned_by_current_login === 1 ? [a, b] : [b, a];
}

/**
 * `startingSlots` is passed for my team only: it turns "fewer starters than the league requires" into the
 * empty-slot alert, and its being set is also what marks the team as mine.
 */
function buildTeam(
  team: Team,
  players: Player[],
  games: Map<string, NflGame> | undefined,
  records: Map<string, TeamRecord> | undefined,
  startingSlots: number | undefined,
): TeamScore {
  const gameOf = (p: Player) =>
    p.editorial_team_abbr ? games?.get(espnAbbreviation(p.editorial_team_abbr)) : undefined;
  const line = (p: Player): PlayerLine => {
    const points = p.player_points?.total ?? 0;
    const status = playerStatus(gameOf(p), games !== undefined, points);
    const injury = INJURIES[p.status ?? ""];
    return {
      name: p.name.full,
      position: p.primary_position,
      points,
      // Before kickoff every stat is 0, which would read as a (wrong) "0 PA" for a defense.
      statLine: status === "pre" ? undefined : statLine(p.primary_position, yahooStats(p)),
      game: gameOf(p)?.info,
      ...(injury && { injury }),
      status,
    };
  };

  const slot = (p: Player) => p.selected_position.position;
  const checks = players
    .filter((p) => !BENCH_SLOTS.has(slot(p)))
    .sort((a, b) => slotRank(slot(a)) - slotRank(slot(b)))
    // Yahoo's roster omits empty slots, like ESPN's. `hasGame` feeds the "no game this week" alert.
    .map((p) => ({ line: line(p), hasGame: games ? gameOf(p) !== undefined : undefined }));
  const starters = checks.map((c) => c.line);

  const manager = team.managers.map((m) => m.manager.nickname).find((n) => n && n !== "--hidden--");
  return {
    name: team.name,
    owner: manager ?? undefined,
    record: records?.get(team.team_key),
    points: team.team_points.total,
    projected: team.team_projected_points?.total,
    winProbability: team.win_probability ?? undefined,
    // "Left" means still has points to add: not started yet, or mid-game.
    playersRemaining: games ? starters.filter((p) => p.status !== "done").length : undefined,
    alerts:
      startingSlots === undefined
        ? undefined
        : lineupAlerts(checks, Math.max(0, startingSlots - starters.length)),
    starters,
    bench: players.filter((p) => BENCH_SLOTS.has(slot(p))).map(line),
  };
}

// This week's box score in our platform-neutral stat names.
function yahooStats(p: Player): Stats | undefined {
  const raw = new Map<string, number>();
  for (const { stat } of p.player_stats?.stats ?? []) {
    const value = Number(stat.value);
    if (Number.isFinite(value)) raw.set(stat.stat_id, value);
  }
  if (raw.size === 0) return undefined;

  const stats: Stats = {};
  const set = (key: keyof Stats, value: number | undefined) => {
    if (value !== undefined) stats[key] = value;
  };
  // One raw stat, or undefined if this league doesn't score it.
  const one = (id: string) => raw.get(id);
  // Several raw stats added up, or undefined if the league scores none of them.
  const sum = (ids: string[]) =>
    ids.some((id) => raw.has(id)) ? ids.reduce((s, id) => s + (raw.get(id) ?? 0), 0) : undefined;

  set("passAtt", one(STAT.passAtt));
  set("passCmp", one(STAT.passCmp));
  set("passYd", one(STAT.passYd));
  set("passTd", one(STAT.passTd));
  set("passInt", one(STAT.passInt));
  set("rushAtt", one(STAT.rushAtt));
  set("rushYd", one(STAT.rushYd));
  set("rushTd", one(STAT.rushTd));
  set("rec", one(STAT.rec));
  set("recYd", one(STAT.recYd));
  set("recTd", one(STAT.recTd));
  set("fumLost", one(STAT.fumLost));
  set("defSack", one(STAT.defSack));
  set("defInt", one(STAT.defInt));
  set("defFumRec", one(STAT.defFumRec));
  set("ptsAllowed", one(STAT.ptsAllowed));
  const fgMade = sum(FG_MADE);
  set("fgm", fgMade);
  set("fga", fgMade === undefined ? undefined : fgMade + (sum(FG_MISSED) ?? 0));
  const xpMade = one(STAT.xpMade);
  set("xpm", xpMade);
  set("xpa", xpMade === undefined ? undefined : xpMade + (one(STAT.xpMiss) ?? 0));
  return stats;
}

function playerStatus(game: NflGame | undefined, haveGames: boolean, points: number): PlayerLine["status"] {
  if (!haveGames) return points !== 0 ? "live" : "pre";
  // Not on this week's scoreboard: a bye week, or an empty slot, so there's nothing left to play.
  if (game === undefined || game.state === "post") return "done";
  return game.state === "in" ? "live" : "pre";
}

function matchupStatus(yahooStatus: string, starters: PlayerLine[]): MatchupStatus {
  if (yahooStatus === "postevent") return "final";
  if (starters.length > 0 && starters.every((p) => p.status === "done")) return "final";
  if (starters.every((p) => p.status === "pre")) return "pre";
  return "live";
}

function slotRank(slot: string): number {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
}
