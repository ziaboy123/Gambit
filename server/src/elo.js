export const STARTING_ELO = 1200;
const K_FACTOR = 32;

// scoreA: 1 for a win, 0.5 for a draw, 0 for a loss.
export function computeNewRating(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K_FACTOR * (scoreA - expectedA));
}
