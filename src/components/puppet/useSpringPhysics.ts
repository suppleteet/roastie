import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { springStep, makeSpring, type SpringState } from "@/lib/spring";

export interface SpringAxes {
  pitch: SpringState;
  yaw: SpringState;
  roll: SpringState;
  bobY: SpringState;
}

export interface SpringTargets {
  pitch: number;
  yaw: number;
  roll: number;
  bobY: number;
}

/**
 * Returns a ref containing current spring values for head rotation + body bob.
 * useMotionState writes to `targets`; this hook reads them each frame.
 */
export function useSpringPhysics(
  stiffnessRef: React.MutableRefObject<number>,
  dampingRef: React.MutableRefObject<number>,
  targets: React.MutableRefObject<SpringTargets>
): React.MutableRefObject<SpringAxes> {
  // Initialize at sleeping position so there's no initial drift from zero
  const springs = useRef<SpringAxes>({
    pitch: makeSpring(-0.65),
    yaw: makeSpring(0),
    roll: makeSpring(0.05),
    bobY: makeSpring(-0.08),
  });

  useFrame((_, delta) => {
    const k = stiffnessRef.current;
    const d = dampingRef.current;
    const t = targets.current;
    const s = springs.current;

    s.pitch = springStep(s.pitch, t.pitch, k, d, delta);
    s.yaw = springStep(s.yaw, t.yaw, k, d, delta);
    s.roll = springStep(s.roll, t.roll, k, d, delta);
    s.bobY = springStep(s.bobY, t.bobY, k, d, delta);
  });

  return springs;
}
