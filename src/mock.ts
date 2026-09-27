import type { Matchup, PlayerLine, TeamScore } from "./types.js";

// Placeholder data for platforms without a real adapter yet (Yahoo until Step 4).
// Points drift upward on each call so the UI visibly refreshes.
const start = Date.now();

export type MockPlatform = "yahoo";

function drift(base: number, rate: number): number {
  const minutes = (Date.now() - start) / 60_000;
  return Math.round((base + minutes * rate) * 100) / 100;
}

function team(
  name: string,
  owner: string,
  points: number,
  projected: number | undefined,
  playersRemaining: number,
  starters: PlayerLine[],
): TeamScore {
  return { name, owner, points, projected, playersRemaining, starters };
}

export function mockMatchup(platform: MockPlatform): Matchup {
  return {
    platform,
    leagueName: "College Buddies",
    week: 4,
    status: "live",
    updatedAt: new Date().toISOString(),
    me: team("Hail Mary Heroes", "Kevin", drift(64.0, 1.1), 104.3, 5, []),
    opponent: team("Fumble Force", "Sam", drift(58.5, 1.0), 99.8, 4, []),
  };
}
