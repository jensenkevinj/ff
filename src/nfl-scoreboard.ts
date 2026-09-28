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
};

const scoreboardSchema = z.object({
  events: z.array(
    z.object({
      competitions: z.array(
        z.object({
          status: z.object({ type: z.object({ state: z.string() }) }),
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
  for (const event of data.events) {
    for (const game of event.competitions) {
      const s = game.status.type.state;
      // Anything unexpected (e.g. "postponed") counts as not started yet.
      const state: GameState = s === "in" || s === "post" ? s : "pre";
      for (const { team } of game.competitors) {
        byTeamId.set(Number(team.id), state);
        byAbbreviation.set(team.abbreviation, state);
      }
    }
  }
  return { byTeamId, byAbbreviation };
}
