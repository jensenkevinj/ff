export type Platform = "espn" | "yahoo" | "sleeper";

export type MatchupStatus = "pre" | "live" | "final";

/** The NFL game a player is in, from their team's side. Fields fill in as the game progresses. */
export type PlayerGame = {
  kickoff?: string; // ISO 8601; the page formats it in the viewer's time zone
  broadcast?: string; // "ESPN"
  score?: string; // "DEN 16–13 LAR", this team first; once the game has started
  clock?: string; // "1:31 3rd", "Halftime"; only while it's being played
  hasBall?: boolean;
  situation?: string; // "3rd & 3 at LAR 37", when this team has the ball
  redZone?: boolean; // this team has the ball inside the opponent's 20
};

/** Short injury designation, as the apps badge it. */
export type InjuryStatus = "Q" | "D" | "DTD" | "O" | "IR" | "PUP" | "SUS";

export type PlayerLine = {
  name: string;
  position: string;
  points: number;
  projected?: number;
  injury?: InjuryStatus;
  game?: PlayerGame; // absent on a bye, for a free agent, or if the NFL scoreboard is down
  statLine?: string; // box score, e.g. "5 REC, 62 YD, 1 TD"; absent until the player has stats
  status: "pre" | "live" | "done";
};

export type TeamRecord = {
  wins: number;
  losses: number;
  ties: number;
  rank?: number; // place in the league standings, 1 = first
};

export type TeamScore = {
  name: string;
  owner?: string;
  record?: TeamRecord; // season so far, not counting this week
  points: number;
  projected?: number; // expected final score (ESPN: its own; Sleeper: from projections)
  playersRemaining?: number;
  winProbability?: number; // 0–1; ESPN's own, or our estimate for Sleeper
  alerts?: string[]; // my team only: lineup problems to fix before kickoff (empty slot, starter out)
  starters?: PlayerLine[];
  bench?: PlayerLine[]; // bench and IR; their points don't count toward `points`
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
