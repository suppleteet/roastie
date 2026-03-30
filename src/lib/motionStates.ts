// MotionState is canonically defined in @/lib/stateMachine/motionState.ts
export type { MotionState } from "@/lib/stateMachine";
import type { MotionState } from "@/lib/stateMachine";

export interface MotionStateConfig {
  /** Spring stiffness override (higher = snappier) */
  stiffness: number;
  /** Spring damping override */
  damping: number;
  /** Head rotation X target (pitch, radians) — positive = nod down */
  headPitch: number;
  /** Head rotation Y target (yaw, radians) — positive = turn right */
  headYaw: number;
  /** Head rotation Z target (roll, radians) — positive = tilt right */
  headRoll: number;
  /** Body translation Y offset (positive = up) */
  bodyBob: number;
  /** Oscillation frequency in Hz (for bobbing states) */
  oscFreq: number;
  /** Oscillation amplitude scale */
  oscAmp: number;
}

export const MOTION_STATE_CONFIGS: Record<MotionState, MotionStateConfig> = {
  idle: {
    stiffness: 40,
    damping: 10,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    bodyBob: 0,
    oscFreq: 0.4,
    oscAmp: 0.008,
  },
  laugh: {
    stiffness: 200,
    damping: 15,
    headPitch: 0.15,
    headYaw: 0,
    headRoll: 0,
    bodyBob: 0.04,
    oscFreq: 3.0,
    oscAmp: 0.06,
  },
  energetic: {
    stiffness: 180,
    damping: 12,
    headPitch: -0.1,
    headYaw: 0.25,
    headRoll: 0.15,
    bodyBob: 0.02,
    oscFreq: 1.5,
    oscAmp: 0.04,
  },
  smug: {
    stiffness: 30,
    damping: 14,
    headPitch: -0.12,
    headYaw: 0.1,
    headRoll: 0.08,
    bodyBob: 0,
    oscFreq: 0.2,
    oscAmp: 0.01,
  },
  conspiratorial: {
    stiffness: 50,
    damping: 12,
    headPitch: 0.08,
    headYaw: -0.15,
    headRoll: 0.06,
    bodyBob: -0.02,
    oscFreq: 0.3,
    oscAmp: 0.01,
  },
  shocked: {
    stiffness: 300,
    damping: 25,
    headPitch: -0.25,
    headYaw: 0,
    headRoll: 0,
    bodyBob: -0.05,
    oscFreq: 0.1,
    oscAmp: 0.005,
  },
  emphasis: {
    stiffness: 250,
    damping: 18,
    headPitch: 0.2,
    headYaw: 0,
    headRoll: 0,
    bodyBob: 0.03,
    oscFreq: 2.0,
    oscAmp: 0.03,
  },
  thinking: {
    stiffness: 35,
    damping: 12,
    headPitch: -0.05,
    headYaw: 0.18,
    headRoll: 0.12,
    bodyBob: 0,
    oscFreq: 0.15,
    oscAmp: 0.005,
  },
  listening: {
    stiffness: 30,
    damping: 12,
    headPitch: 0.05,
    headYaw: 0,
    headRoll: 0.03,
    bodyBob: 0,
    oscFreq: 0.2,
    oscAmp: 0.006,
  },
  sleeping: {
    stiffness: 15,
    damping: 8,
    headPitch: -0.65,  // chin tucked down
    headYaw: 0,
    headRoll: 0.05,    // slight tilt
    bodyBob: -0.08,    // slumped down
    oscFreq: 0.15,     // slow breathing
    oscAmp: 0.015,
  },
};
