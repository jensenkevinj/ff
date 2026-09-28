import { z } from "zod";
import { fetchJson } from "./http.js";

// ESPN's public NFL scoreboard: real game states, so cards can tell "hasn't played" from "played and
// scored 0". Its team IDs are the same numbers as `proTeamId` in ESPN fantasy responses.
const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export type GameState = "pre" | "in" | "post";

export type NflGameStates = {
  /** Keyed by ESPN team ID, the same numbers as `proTeamId` in ESPN fantasy responses. */
  byTeamId: Map<number, GameState>;
  /** Keyed by ESPN's team abbreviation ("BUF", "WSH"). */
  byAbbreviation: Map<string, GameState>;
  /** Share of each team's game still to play, 1 before kickoff to 0 at the end; by abbreviation. */
  fractionLeft: Map<string, number>;
};

const QUARTER_SECONDS = 15 * 60;

const scoreboardSchema = z.object({
  events: z.array(
    z.object({
      competitions: z.array(
        z.object({
          status: z.object({
            type: z.object({ state: z.string() }),
            period: z.number().nullish(), // quarter; 5+ is overtime
            clock: z.number().nullish(), // seconds left in the quarter
          }),
          competitors: z.array(z.object({ team: z.object({ id: z.string(), abbreviation: z.string() }) })),
        }),
      ),
    }),
  ),
});

/** Game state for each NFL team playing in `week` of the regular season. Teams on a bye are absent. */
export async function fetchNflGameStates(opts: {
  season: number;
  week: number;
  fetch: typeof globalThis.fetch;
}): Promise<NflGameStates> {
  // Ask for the week explicitly: the default "current" scoreboard can roll over to next week
  // before a fantasy matchup is final.
  const url = `${SCOREBOARD_URL}?dates=${opts.season}&seasontype=2&week=${opts.week}`;
  const data = await fetchJson(url, scoreboardSchema, { service: "ESPN scoreboard", fetch: opts.fetch });

  const byTeamId = new Map<number, GameState>();
  const byAbbreviation = new Map<string, GameState>();
  const fractionLeft = new Map<string, number>();
  for (const event of data.events) {
    for (const game of event.competitions) {
      const s = game.status.type.state;
      // Anything unexpected (e.g. "postponed") counts as not started yet.
      const state: GameState = s === "in" || s === "post" ? s : "pre";
      const left = gameLeft(state, game.status.period, game.status.clock);
      for (const { team } of game.competitors) {
        byTeamId.set(Number(team.id), state);
        byAbbreviation.set(team.abbreviation, state);
        fractionLeft.set(team.abbreviation, left);
      }
    }
  }
  return { byTeamId, byAbbreviation, fractionLeft };
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
