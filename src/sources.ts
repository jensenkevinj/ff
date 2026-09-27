import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSleeperAdapter, type Log } from "./adapters/sleeper.js";
import type { Config } from "./config.js";
import { mockMatchup } from "./mock.js";
import type { Matchup, Platform } from "./types.js";

// One entry per league shown on the page. The route doesn't care whether data is real or mock.
export type MatchupSource = {
  platform: Platform;
  load: (log: Log) => Promise<Matchup>;
};

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  // Mock data until Steps 3 and 4 replace these with real adapters.
  for (const platform of ["espn", "yahoo"] as const) {
    sources.push({ platform, load: () => Promise.resolve(mockMatchup(platform)) });
  }

  return sources;
}
