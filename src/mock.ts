import type { Matchup, PlayerLine, TeamScore } from "./types.js";

// Placeholder data for platforms without a real adapter yet (ESPN until Step 3, Yahoo until Step 4).
// Points drift upward on each call so the UI visibly refreshes.
const start = Date.now();

export type MockPlatform = "espn" | "yahoo";

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
  const updatedAt = new Date().toISOString();
  switch (platform) {
    case "espn":
      return {
        platform: "espn",
        leagueName: "Office League",
        week: 4,
        status: "live",
        updatedAt,
        me: team("Kevin's Kickers", "Kevin", drift(87.4, 1.3), 118.2, 3, [
          { name: "Josh Allen", position: "QB", points: 24.6, projected: 23.1, status: "done" },
          { name: "Bijan Robinson", position: "RB", points: 18.2, projected: 17.5, status: "live" },
          { name: "Ja'Marr Chase", position: "WR", points: 0, projected: 19.0, status: "pre" },
        ]),
        opponent: team("Gridiron Gurus", "Alex", drift(92.1, 0.9), 110.7, 2, []),
      };
    case "yahoo":
      return {
        platform: "yahoo",
        leagueName: "College Buddies",
        week: 4,
        status: "live",
        updatedAt,
        me: team("Hail Mary Heroes", "Kevin", drift(64.0, 1.1), 104.3, 5, []),
        opponent: team("Fumble Force", "Sam", drift(58.5, 1.0), 99.8, 4, []),
      };
  }
}
