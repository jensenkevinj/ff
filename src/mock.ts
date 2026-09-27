import type { Matchup, PlayerLine, TeamScore } from "./types.js";

// Step 1 placeholder data. Points drift upward on each call so the UI visibly refreshes.
const start = Date.now();

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

export function mockMatchups(): Matchup[] {
  const updatedAt = new Date().toISOString();
  return [
    {
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
    },
    {
      platform: "yahoo",
      leagueName: "College Buddies",
      week: 4,
      status: "live",
      updatedAt,
      me: team("Hail Mary Heroes", "Kevin", drift(64.0, 1.1), 104.3, 5, []),
      opponent: team("Fumble Force", "Sam", drift(58.5, 1.0), 99.8, 4, []),
    },
    {
      platform: "sleeper",
      leagueName: "Dynasty Degenerates",
      week: 4,
      status: "pre",
      updatedAt,
      me: team("kjensen", "kjensen", 0, undefined, 9, []),
      opponent: team("taco_tuesday", "taco_tuesday", 0, undefined, 9, []),
    },
  ];
}
