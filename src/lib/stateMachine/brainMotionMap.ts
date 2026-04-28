import type { BrainState } from "./brainState";
import type { MotionState } from "./motionState";

export interface BrainMotionDefault {
  motion: MotionState;
  intensity: number;
}

/**
 * Default puppet motion implied by each brain state.
 * Per-joke motion tags override this during delivering/vision_react.
 *
 * Single source of truth — replaces scattered deps.setMotion() calls.
 */
export const BRAIN_MOTION_DEFAULTS: Record<BrainState, BrainMotionDefault> = {
  greeting:      { motion: "energetic",      intensity: 0.8 },
  vision_jokes:  { motion: "thinking",       intensity: 0.6 },
  ask_question:  { motion: "emphasis",       intensity: 0.7 },
  wait_answer:   { motion: "listening",      intensity: 0.5 },
  prodding:      { motion: "conspiratorial", intensity: 0.5 },
  pre_generate:  { motion: "listening",      intensity: 0.5 },
  generating:    { motion: "thinking",       intensity: 0.7 },
  delivering:    { motion: "energetic",      intensity: 0.8 },
  dev_note:      { motion: "idle",           intensity: 0.3 },
  confirm_answer: { motion: "conspiratorial", intensity: 0.6 },
  redirecting:   { motion: "smug",           intensity: 0.7 },
  check_vision:  { motion: "thinking",       intensity: 0.5 },
  vision_react:  { motion: "shocked",        intensity: 0.8 },
  wrapup:        { motion: "idle",           intensity: 0.3 },
};
