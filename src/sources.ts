import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEspnAdapter } from "./adapters/espn.js";
import { createSleeperAdapter } from "./adapters/sleeper.js";
import { createYahooAdapter } from "./adapters/yahoo.js";
import { createYahooAuth } from "./adapters/yahoo-auth.js";
import type { Log } from "./log.js";
import type { Config } from "./config.js";
import type { Matchup, Platform } from "./types.js";

// One entry per league shown on the page.
export type MatchupSource = {
  platform: Platform;
  load: (log: Log) => Promise<Matchup>;
};

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const yahooTokenFile = path.join(projectRoot, ".tokens", "yahoo.json");

// Real adapters are included only when their env vars are set, so the page shows just the
// leagues you've configured.
export function createSources(config: Config): MatchupSource[] {
  const sources: MatchupSource[] = [];

  if (config.SLEEPER_LEAGUE_ID && config.SLEEPER_USERNAME) {
    const sleeper = createSleeperAdapter({
      leagueId: config.SLEEPER_LEAGUE_ID,
      username: config.SLEEPER_USERNAME,
      playersFile: path.join(projectRoot, ".cache", "sleeper-players.json"),
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

  // Yahoo needs the whole OAuth setup, not just the league ID. Without a saved login (`npm run yahoo:auth`)
  // its card shows an error that says so.
  if (
    config.YAHOO_LEAGUE_ID &&
    config.YAHOO_CLIENT_ID &&
    config.YAHOO_CLIENT_SECRET &&
    config.YAHOO_REDIRECT_URI
  ) {
    const yahoo = createYahooAdapter({
      leagueId: config.YAHOO_LEAGUE_ID,
      auth: createYahooAuth({
        clientId: config.YAHOO_CLIENT_ID,
        clientSecret: config.YAHOO_CLIENT_SECRET,
        redirectUri: config.YAHOO_REDIRECT_URI,
        tokenFile: yahooTokenFile,
      }),
    });
    sources.push({ platform: "yahoo", load: (log) => yahoo.getMatchup(log) });
  }

  return sources;
}

// The NFL season is named for the year it starts: January and February games belong to the previous one.
export function nflSeason(date: Date): number {
  return date.getMonth() < 2 ? date.getFullYear() - 1 : date.getFullYear();
}
