export type Platform = "espn" | "yahoo" | "sleeper";

export type MatchupStatus = "pre" | "live" | "final";

export type PlayerLine = {
  name: string;
  position: string;
  points: number;
  projected?: number;
  status: "pre" | "live" | "done";
};

export type TeamScore = {
  name: string;
  owner?: string;
  points: number;
  projected?: number; // Sleeper: usually absent
  playersRemaining?: number;
  starters?: PlayerLine[];
};

export type Matchup = {
  platform: Platform;
  leagueName: string;
  week: number;
  me: TeamScore;
  opponent: TeamScore;
  status: MatchupStatus;
  updatedAt: string;
  error?: string; // per-league failure shown on its card
};
