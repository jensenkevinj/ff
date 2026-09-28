// Win probability for platforms that don't provide one (Sleeper). Each starter's final score is treated
// as a normal distribution, so a team's total is one too, and P(my total > theirs) comes from the
// normal CDF of the difference. Simple and explainable rather than finely calibrated.

/**
 * How much a player's score typically swings around their projection, as a share of it. Fantasy scoring
 * is noisy: a standard deviation around 40–50% of the projection is the common rule of thumb.
 */
const SPREAD = 0.45;

export type PlayerOutlook = {
  points: number; // scored so far
  projected: number; // projection for the whole game
  fractionLeft: number; // 1 before kickoff, 0 once the game is over (or on a bye)
};

type Total = { mean: number; variance: number };

export function teamTotal(players: PlayerOutlook[]): Total {
  let mean = 0;
  let variance = 0;
  for (const p of players) {
    mean += p.points + p.projected * p.fractionLeft;
    // Uncertainty shrinks like a random walk: with a quarter of the game left, half the spread remains.
    const sd = SPREAD * p.projected * Math.sqrt(p.fractionLeft);
    variance += sd * sd;
  }
  return { mean, variance };
}

/** Chance (0–1) that `mine` finishes ahead of `theirs`. */
export function winProbability(mine: Total, theirs: Total): number {
  const diff = mine.mean - theirs.mean;
  const variance = mine.variance + theirs.variance;
  // Nothing left to play: whoever leads has won (a dead heat is a coin flip).
  if (variance === 0) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / Math.sqrt(variance));
}

// JavaScript has no built-in erf. This is the Abramowitz–Stegun 7.1.26 approximation (error < 1.5e-7),
// far more precision than a win percentage needs.
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
