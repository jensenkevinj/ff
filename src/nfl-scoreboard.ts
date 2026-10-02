import { z } from "zod";
import { fetchJson } from "./http.js";
import type { PlayerGame } from "./types.js";

// ESPN's public NFL scoreboard: real game states, so cards can tell "hasn't played" from "played and
// scored 0", plus each game's score, clock and down-and-distance. Its team IDs are the same numbers as
// `proTeamId` in ESPN fantasy responses.
const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export type GameState = "pre" | "in" | "post";

/** One NFL game, seen from one of its two teams. */
export type NflGame = {
  state: GameState;
  /** Share of the game still to play: 1 before kickoff, 0 once it's over. */
  fractionLeft: number;
  /** What the page shows next to this team's players. */
  info: PlayerGame;
};

export type NflGames = {
  /** Keyed by ESPN team ID, the same numbers as `proTeamId` in ESPN fantasy responses. */
  byTeamId: Map<number, NflGame>;
  /** Keyed by ESPN's team abbreviation ("BUF", "WSH"). */
  byAbbreviation: Map<string, NflGame>;
};

const QUARTER_SECONDS = 15 * 60;

// Abbreviations other platforms spell differently from ESPN's scoreboard.
const ESPN_TEAM: Record<string, string> = { WAS: "WSH" };

/** ESPN's abbreviation for a team named by another platform ("Was" from Yahoo, "WAS" from Sleeper → "WSH"). */
export function espnAbbreviation(abbreviation: string): string {
  const upper = abbreviation.toUpperCase();
  return ESPN_TEAM[upper] ?? upper;
}

// Most fields are optional: they only appear for some game states, and trimmed test fixtures omit them.
const scoreboardSchema = z.object({
  events: z.array(
    z.object({
      competitions: z.array(
        z.object({
          date: z.string().nullish(), // kickoff, ISO 8601
          status: z.object({
            type: z.object({ state: z.string(), shortDetail: z.string().nullish() }), // "1:31 - 3rd"
            period: z.number().nullish(), // quarter; 5+ is overtime
            clock: z.number().nullish(), // seconds left in the quarter
          }),
          broadcasts: z.array(z.object({ names: z.array(z.string()) })).nullish(),
          situation: z
            .object({
              possession: z.string().nullish(), // team ID with the ball
              isRedZone: z.boolean().nullish(),
              downDistanceText: z.string().nullish(), // "3rd & 3 at LAR 37"
            })
            .nullish(),
          competitors: z.array(
            z.object({
              score: z.string().nullish(),
              team: z.object({ id: z.string(), abbreviation: z.string() }),
            }),
          ),
        }),
      ),
    }),
  ),
});

type Competition = z.infer<typeof scoreboardSchema>["events"][number]["competitions"][number];
type Competitor = Competition["competitors"][number];

/** Each NFL team playing in `week` of the regular season. Teams on a bye are absent. */
export async function fetchNflGames(opts: {
  season: number;
  week: number;
  fetch: typeof globalThis.fetch;
}): Promise<NflGames> {
  // Ask for the week explicitly: the default "current" scoreboard can roll over to next week
  // before a fantasy matchup is final.
  const url = `${SCOREBOARD_URL}?dates=${opts.season}&seasontype=2&week=${opts.week}`;
  const data = await fetchJson(url, scoreboardSchema, { service: "ESPN scoreboard", fetch: opts.fetch });

  const byTeamId = new Map<number, NflGame>();
  const byAbbreviation = new Map<string, NflGame>();
  for (const event of data.events) {
    for (const game of event.competitions) {
      const s = game.status.type.state;
      // Anything unexpected (e.g. "postponed") counts as not started yet.
      const state: GameState = s === "in" || s === "post" ? s : "pre";
      const fractionLeft = gameLeft(state, game.status.period, game.status.clock);
      for (const team of game.competitors) {
        const opponent = game.competitors.find((c) => c !== team);
        const nflGame = { state, fractionLeft, info: gameInfo(game, state, team, opponent) };
        byTeamId.set(Number(team.team.id), nflGame);
        byAbbreviation.set(team.team.abbreviation, nflGame);
      }
    }
  }
  return { byTeamId, byAbbreviation };
}

function gameInfo(game: Competition, state: GameState, team: Competitor, opponent?: Competitor): PlayerGame {
  const info: PlayerGame = {};
  if (game.date) info.kickoff = game.date;
  const tv = game.broadcasts?.flatMap((b) => b.names)[0];
  if (tv) info.broadcast = tv;
  if (state === "pre") return info;

  // This team first: "DEN 16–13 LAR".
  info.score =
    `${team.team.abbreviation} ${team.score ?? 0}–${opponent?.score ?? 0} ${opponent?.team.abbreviation ?? ""}`.trim();
  if (state === "post") return info;

  // "1:31 - 3rd" → "1:31 3rd"; "Halftime" and "End of 3rd" pass through.
  if (game.status.type.shortDetail) info.clock = game.status.type.shortDetail.replace(" - ", " ");
  if (game.situation?.possession === team.team.id) {
    info.hasBall = true;
    if (game.situation.downDistanceText) info.situation = game.situation.downDistanceText;
    if (game.situation.isRedZone) info.redZone = true;
  }
  return info;
}

function gameLeft(state: GameState, period: number | null | undefined, clock: number | null | undefined) {
  if (state === "pre") return 1;
  if (state === "post") return 0;
  // Mid-game without a clock (or in overtime, which has no fixed length): call it half, or nearly over.
  if (period == null || clock == null) return 0.5;
  if (period > 4) return 0.05;
  const secondsLeft = (4 - period) * QUARTER_SECONDS + clock;
  return Math.min(1, Math.max(0, secondsLeft / (4 * QUARTER_SECONDS)));
}
