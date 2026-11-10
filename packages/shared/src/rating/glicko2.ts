/** Glicko-2 as in Glickman, "Example of the Glicko-2 system", with this project's constants. */
export const GLICKO2 = {
  initialRating: 1500,
  initialRd: 350,
  initialVolatility: 0.06,
  tau: 0.5,
  epsilon: 0.000001,
  rdFloor: 45,
  rdCeiling: 350,
  provisionalRd: 110,
  scale: 173.7178,
} as const;

export type Rating = { rating: number; rd: number; volatility: number };

export const INITIAL_RATING: Rating = {
  rating: GLICKO2.initialRating,
  rd: GLICKO2.initialRd,
  volatility: GLICKO2.initialVolatility,
};

export type Score = 0 | 0.5 | 1;

export type RatedGame = { opponent: Rating; score: Score };

export function isProvisional(rd: number): boolean {
  return rd > GLICKO2.provisionalRd;
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)));
}

function clampRd(rating: Rating): Rating {
  return {
    ...rating,
    rd: Math.min(GLICKO2.rdCeiling, Math.max(GLICKO2.rdFloor, rating.rd)),
  };
}

/** One rating period. Production passes one game; the paper's example passes three. */
export function ratePeriod(
  player: Rating,
  games: readonly RatedGame[],
  tau: number = GLICKO2.tau,
): Rating {
  const { scale, epsilon } = GLICKO2;
  const mu = (player.rating - 1500) / scale;
  const phi = player.rd / scale;
  const sigma = player.volatility;

  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return clampRd({ rating: player.rating, rd: phiStar * scale, volatility: sigma });
  }

  let vInverse = 0;
  let deltaSum = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - 1500) / scale;
    const phiJ = opponent.rd / scale;
    const gJ = g(phiJ);
    const e = expectedScore(mu, muJ, phiJ);
    vInverse += gJ * gJ * e * (1 - e);
    deltaSum += gJ * (score - e);
  }
  const v = 1 / vInverse;
  const delta = v * deltaSum;

  // Step 5: the new volatility, by the Illinois variant of regula falsi.
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta2 - phi2 - v - ex)) / (2 * (phi2 + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > epsilon) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  // Steps 6 and 7.
  const phiStar = Math.sqrt(phi2 + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;

  return clampRd({ rating: muNew * scale + 1500, rd: phiNew * scale, volatility: sigmaNew });
}

/** `φ² ← min(φ² + d·σ², (350 / 173.7178)²)` for `d` idle days before a result. */
export function inflateForInactivity(player: Rating, idleDays: number): Rating {
  if (idleDays <= 0) return player;
  const { scale, rdCeiling } = GLICKO2;
  const phi2 = (player.rd / scale) ** 2;
  const ceiling2 = (rdCeiling / scale) ** 2;
  const inflated = Math.min(phi2 + idleDays * player.volatility ** 2, ceiling2);
  return { ...player, rd: Math.sqrt(inflated) * scale };
}
