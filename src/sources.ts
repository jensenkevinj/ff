import { createEspnAdapter } from "./adapters/espn.js";
import { createSleeperAdapter } from "./adapters/sleeper.js";
import type { Log } from "./log.js";
import type { Config } from "./config.js";
import { mockMatchup } from "./mock.js";
import { sleeperPlayersFile } from "./paths.js";
import type { Matchup, Platform } from "./types.js";

// One entry per league shown on the page. The route doesn't care whether data is real or mock.
export type MatchupSource = {
  platform: Platform;
  load: (log: Log) => Promise<Matchup>;
};

// Real adapters are included only when their env vars are set, so the page shows just the
// leagues you've configured.
export function createSources(config: Config): MatchupSource[] {
  const sources: MatchupSource[] = [];

  if (config.SLEEPER_LEAGUE_ID && config.SLEEPER_USERNAME) {
    const sleeper = createSleeperAdapter({
      leagueId: config.SLEEPER_LEAGUE_ID,
      username: config.SLEEPER_USERNAME,
      playersFile: sleeperPlayersFile,
    });
    sources.push({ platform: "sleeper", load: (log) => sleeper.getMatchup(log) });
  }

  if (config.ESPN_LEAGUE_ID) {
    const espn = createEspnAdapter({
      leagueId: config.ESPN_LEAGUE_ID,
      season: config.ESPN_SEASON ?? nflSeason(new Date()),
      teamId: config.ESPN_TEAM_ID,
      espnS2: config.ESPN_S2,
      swid: config.ESPN_SWID,
    });
    sources.push({ platform: "espn", load: (log) => espn.getMatchup(log) });
  }

  // Mock data until Step 4 replaces it with a real adapter.
  sources.push({ platform: "yahoo", load: () => Promise.resolve(mockMatchup("yahoo")) });

  return sources;
}

// The NFL season is named for the year it starts: January and February games belong to the previous one.
export function nflSeason(date: Date): number {
  return date.getMonth() < 2 ? date.getFullYear() - 1 : date.getFullYear();
}
