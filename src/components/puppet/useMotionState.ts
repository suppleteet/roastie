import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MOTION_STATE_CONFIGS } from "@/lib/motionStates";
import type { MotionState } from "@/lib/motionStates";
import { useSessionStore } from "@/store/useSessionStore";
import type { SpringTargets } from "./useSpringPhysics";

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

    // Update spring params from motion state config
    stiffnessRef.current = cfg.stiffness;
    dampingRef.current = cfg.damping;

    // Oscillation for states that need it
    const osc = Math.sin(t * cfg.oscFreq * Math.PI * 2) * cfg.oscAmp;
    // Amplitude micro-reactivity — louder = slightly more extreme
    const ampScale = 1 + audioAmplitude * 0.3;

    targets.current = {
      pitch: (cfg.headPitch + osc * 0.5) * effectiveIntensity * ampScale,
      yaw: (cfg.headYaw + osc * 0.3) * effectiveIntensity * ampScale,
      roll: (cfg.headRoll + osc * 0.2) * effectiveIntensity * ampScale,
      bobY: (cfg.bodyBob + osc) * effectiveIntensity * ampScale,
    };
  });

  return { stiffnessRef, dampingRef };
}
