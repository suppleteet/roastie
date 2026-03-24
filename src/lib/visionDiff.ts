/**
 * Vision observation diff — detects interesting changes between two observation sets.
 *
 * Used by ComedianBrain in check_vision to decide whether to interrupt the Q&A
 * flow with a vision_react moment.
 */

/** Keywords that make an observation automatically "interesting" — keep tight to avoid
 *  vision_react firing every cycle. Removed "moved", "changed", "different" (too broad). */
const HIGH_INTEREST_KEYWORDS = [
  "laugh", "smiling", "crying", "upset",
  "new person", "someone else", "another person", "walked in",
  "pet", "dog", "cat", "animal",
  "phone", "eating", "drinking",
  "hat", "glasses",
];

/** Fuzzy substring match — observation b is "similar" to a if either contains the other */
function isSimilar(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb) || lb.includes(la);
}

export interface VisionDiffResult {
  isInteresting: boolean;
  changes: string[];
}

/**
 * Compare two sets of vision observations.
 * Returns { isInteresting, changes } where changes are observations in `current`
 * that don't appear in `prev`.
 */
export function diffObservations(
  prev: string[],
  current: string[],
): VisionDiffResult {
  if (current.length === 0) return { isInteresting: false, changes: [] };

  const changes: string[] = [];
  for (const obs of current) {
    const alreadySeen = prev.some((p) => isSimilar(p, obs));
    if (!alreadySeen) {
      changes.push(obs);
    }
  }

  // High-interest if any new observation matches a keyword
  const hasHighInterest = changes.some((c) => {
    const cl = c.toLowerCase();
    return HIGH_INTEREST_KEYWORDS.some((kw) => cl.includes(kw));
  });

  // Also interesting if 4+ genuinely new observations (high bar to avoid constant vision interrupts)
  const isInteresting = hasHighInterest || changes.length >= 4;

  return { isInteresting, changes };
}
