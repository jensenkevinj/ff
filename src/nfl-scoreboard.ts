import { z } from "zod";
import { fetchJson } from "./http.js";

// ESPN's public NFL scoreboard: real game states, so cards can tell "hasn't played" from "played and
// scored 0". Its team IDs are the same numbers as `proTeamId` in ESPN fantasy responses.
const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export type GameState = "pre" | "in" | "post";

const scoreboardSchema = z.object({
  events: z.array(
    z.object({
      competitions: z.array(
        z.object({
          status: z.object({ type: z.object({ state: z.string() }) }),
          competitors: z.array(z.object({ team: z.object({ id: z.string() }) })),
        }),
      ),
    }),
  ),
});

/** Game state for each NFL team playing in `week` of the regular season, keyed by ESPN team ID. */
export async function fetchNflGameStates(opts: {
  season: number;
  week: number;
  fetch: typeof globalThis.fetch;
}): Promise<Map<number, GameState>> {
  // Ask for the week explicitly: the default "current" scoreboard can roll over to next week
  // before a fantasy matchup is final.
  const url = `${SCOREBOARD_URL}?dates=${opts.season}&seasontype=2&week=${opts.week}`;
  const data = await fetchJson(url, scoreboardSchema, { service: "ESPN scoreboard", fetch: opts.fetch });

  const states = new Map<number, GameState>();
  for (const event of data.events) {
    for (const game of event.competitions) {
      const s = game.status.type.state;
      // Anything unexpected (e.g. "postponed") counts as not started yet.
      const state: GameState = s === "in" || s === "post" ? s : "pre";
      for (const c of game.competitors) states.set(Number(c.team.id), state);
    }
  }
  return states;
}
