import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MOTION_STATE_CONFIGS } from "@/lib/motionStates";
import type { MotionState } from "@/lib/motionStates";
import { useSessionStore } from "@/store/useSessionStore";
import type { SpringTargets } from "./useSpringPhysics";

/**
 * Simple seeded hash-based noise — cheap, deterministic, no allocations.
 * Returns a smooth value in [-1, 1] by interpolating between hashed grid points.
 */
function smoothNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  // Smoothstep
  const s = f * f * (3 - 2 * f);
  const hash = (n: number) => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  return hash(i) * (1 - s) + hash(i + 1) * s;
}

/**
 * Reads activeMotionState + amplitude from store each frame.
 * Writes to the spring targets and returns stiffness/damping refs.
 * Forces "sleeping" state when not actively roasting.
 */
export function useMotionState(targets: React.MutableRefObject<SpringTargets>) {
  const stiffnessRef = useRef(40);
  const dampingRef = useRef(10);
  const timeRef = useRef(0);

  useFrame((_, delta) => {
    timeRef.current += delta;
    const t = timeRef.current;
    const { activeMotionState, motionIntensity, audioAmplitude, hasSpokenThisSession } =
      useSessionStore.getState();

    const awake = hasSpokenThisSession;
    const effectiveState: MotionState = awake ? activeMotionState : "sleeping";
    const effectiveIntensity = awake ? motionIntensity : 1.0;

    const cfg = MOTION_STATE_CONFIGS[effectiveState];

    stiffnessRef.current = cfg.stiffness;
    dampingRef.current = cfg.damping;

    // Idle breathing oscillation (always present, subtle)
    const breathe = Math.sin(t * cfg.oscFreq * Math.PI * 2) * cfg.oscAmp;

    // Speech-driven head variation — independent noise per axis at different speeds
    // Amplitude gates the motion so head is still when not speaking
    const speechDrive = Math.min(audioAmplitude * 2.5, 1);
    const pitchNoise = smoothNoise(t * 2.3, 0) * 0.12 * speechDrive;
    const yawNoise   = smoothNoise(t * 1.7, 100) * 0.18 * speechDrive;
    const rollNoise  = smoothNoise(t * 1.1, 200) * 0.06 * speechDrive;

    targets.current = {
      pitch: (cfg.headPitch + breathe * 0.5 + pitchNoise) * effectiveIntensity,
      yaw:   (cfg.headYaw   + breathe * 0.3 + yawNoise)   * effectiveIntensity,
      roll:  (cfg.headRoll  + breathe * 0.2 + rollNoise)   * effectiveIntensity,
      bobY:  (cfg.bodyBob   + breathe)                     * effectiveIntensity,
    };
  });

  return { stiffnessRef, dampingRef };
}
