import type { TransitionMap } from "./types";

export type MotionState =
  | "idle"
  | "laugh"
  | "energetic"
  | "smug"
  | "conspiratorial"
  | "shocked"
  | "emphasis"
  | "thinking"
  | "listening"
  | "sleeping";

/** All motion states — used to build the any-to-any transition map. */
const ALL_MOTION_STATES: readonly MotionState[] = [
  "idle", "laugh", "energetic", "smug", "conspiratorial",
  "shocked", "emphasis", "thinking", "listening", "sleeping",
] as const;

/**
 * Motion allows any-to-any transitions (spring physics handles smooth blending).
 * The map exists for API consistency and so we can restrict it later.
 */
export const MOTION_TRANSITIONS: TransitionMap<MotionState> =
  Object.fromEntries(ALL_MOTION_STATES.map((s) => [s, ALL_MOTION_STATES])) as TransitionMap<MotionState>;
