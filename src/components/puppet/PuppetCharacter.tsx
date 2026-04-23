"use client";
import React, { useRef, Suspense } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { useMotionState } from "./useMotionState";
import { useSpringPhysics } from "./useSpringPhysics";
import type { SpringTargets } from "./useSpringPhysics";
import { useSessionStore } from "@/store/useSessionStore";

const R = 1.0; // head sphere radius

// ── Magic triangle eye placement ───────────────────────────────────────────
// Eyes nearly touching, close to nose, converging on a shared focal point
// (classic Muppet "magic triangle", Don Sahlin).
//
// Sphere surface positions: x=±0.15, y=0.52, z=0.84
//   |pos| = √(0.0225 + 0.2704 + 0.7056) = 0.9985 ≈ 1.0  ✓
//
// Eye dome rotation: setFromUnitVectors(Y, normalize(eyePos))
//   so the flat base is flush with the sphere and the dome protrudes outward.
//   Left  q=[0.482, 0, 0.086, 0.872] → Euler XYZ ≈ [1.004, -0.083, 0.151]
//   Right q=[0.482, 0,-0.086, 0.872] → Euler XYZ ≈ [1.004,  0.083,-0.151]
const LEFT_EYE_POS:  [number, number, number] = [-0.15, 0.52, 0.84];
const RIGHT_EYE_POS: [number, number, number] = [ 0.15, 0.52, 0.84];
const LEFT_EYE_ROT:  [number, number, number] = [1.004, -0.083,  0.151];
const RIGHT_EYE_ROT: [number, number, number] = [1.004,  0.083, -0.151];

// Pupil: sphere fixed in each eye's local space at the point where the head's
// local +Z axis intersects the white dome.
//
// Computed: R_eye⁻¹ · [0,0,1] → normalize → × 0.207 (15% poke-out depth)
//   Left  R⁻¹·[0,0,1] ≈ [0.172, 0.826, 0.538] → × 0.207 = [ 0.036, 0.171, 0.111]
//   Right R⁻¹·[0,0,1] ≈ [-0.172, 0.826, 0.538] → × 0.207 = [-0.036, 0.171, 0.111]
const PUPIL_RADIUS = 0.133;
const LEFT_PUPIL_POS:  [number, number, number] = [ 0.036, 0.171, 0.111];
const RIGHT_PUPIL_POS: [number, number, number] = [-0.036, 0.171, 0.111];

const HEAD_COLOR  = "#5a1a8a";
const EYE_WHITE   = "#f0f0f0";
const PUPIL_COLOR = "#0a0a0a";
const NOSE_COLOR  = "#f5e560"; // light yellow
const BROW_COLOR  = "#2a0050"; // dark purple

interface Props {
  modelUrl?: string | null;
}

export default function PuppetCharacter({ modelUrl = null }: Props) {
  const groupRef = useRef<THREE.Group>(null);

  const targets = useRef<SpringTargets>({ pitch: 0.65, yaw: 0, roll: 0.05, bobY: -0.03 });
  const { stiffnessRef, dampingRef } = useMotionState(targets);
  const springs = useSpringPhysics(stiffnessRef, dampingRef, targets);

  useFrame(() => {
    const s = springs.current;
    if (!groupRef.current) return;
    groupRef.current.rotation.x = s.pitch.value;
    groupRef.current.rotation.y = s.yaw.value;
    groupRef.current.rotation.z = s.roll.value;
    groupRef.current.position.y = 0;
  });

  return (
    <group ref={groupRef}>
      {modelUrl ? (
        <GLBErrorBoundary fallback={<ProceduralHead />}>
          <Suspense fallback={<ProceduralHead />}>
            <GLBModel modelUrl={modelUrl} />
          </Suspense>
        </GLBErrorBoundary>
      ) : (
        <ProceduralHead />
      )}
    </group>
  );
}

// ── GLB loader — unconditional hook call, Suspense handles loading ────────────
function GLBModel({ modelUrl }: { modelUrl: string }) {
  const { scene } = useGLTF(modelUrl);
  return <primitive object={scene} scale={1} />;
}

// ── Error boundary for GLB load failures (404, parse errors, etc.) ───────────
class GLBErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// ── Procedural puppet head (fallback when no GLB is available) ────────────────
function ProceduralHead() {
  return (
    // Eyes and nose are children of MouthHemispheres so they tilt with the top jaw
    <MouthHemispheres>
      {/* ── Left eye ── */}
      <group position={LEFT_EYE_POS} rotation={LEFT_EYE_ROT}>
        <mesh>
          <sphereGeometry args={[0.30, 40, 40, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={EYE_WHITE} roughness={0.08} />
        </mesh>
        <mesh position={LEFT_PUPIL_POS}>
          <sphereGeometry args={[PUPIL_RADIUS, 24, 24]} />
          <meshStandardMaterial color={PUPIL_COLOR} roughness={0.3} />
        </mesh>
      </group>

      {/* ── Right eye ── */}
      <group position={RIGHT_EYE_POS} rotation={RIGHT_EYE_ROT}>
        <mesh>
          <sphereGeometry args={[0.30, 40, 40, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={EYE_WHITE} roughness={0.08} />
        </mesh>
        <mesh position={RIGHT_PUPIL_POS}>
          <sphereGeometry args={[PUPIL_RADIUS, 24, 24]} />
          <meshStandardMaterial color={PUPIL_COLOR} roughness={0.3} />
        </mesh>
      </group>

      {/* ── Nose ── */}
      <Nose />

      {/* ── Angry eyebrows — sitting above the white dome tops ── */}
      <mesh position={[-0.17, 0.82, 0.80]} rotation={[0.9, -0.1, -0.42]}>
        <boxGeometry args={[0.36, 0.13, 0.08]} />
        <meshStandardMaterial color={BROW_COLOR} roughness={0.4} />
      </mesh>
      <mesh position={[0.17, 0.82, 0.80]} rotation={[0.9, 0.1, 0.42]}>
        <boxGeometry args={[0.36, 0.13, 0.08]} />
        <meshStandardMaterial color={BROW_COLOR} roughness={0.4} />
      </mesh>
    </MouthHemispheres>
  );
}

// ── Mouth: top and bottom hemispheres counter-rotate; eyes/nose ride the top ─
function MouthHemispheres({ children }: { children?: React.ReactNode }) {
  const topGroupRef    = useRef<THREE.Group>(null);
  const bottomGroupRef = useRef<THREE.Group>(null);
  const openAmt        = useRef(0);

  useFrame(() => {
    const amp = useSessionStore.getState().audioAmplitude;
    // Fast attack (0.5), slower release (0.15) for snappy but smooth mouth
    const speed = amp > openAmt.current ? 0.5 : 0.15;
    openAmt.current += (amp - openAmt.current) * speed;

    // Bottom jaw rotates downward  (+X)
    if (bottomGroupRef.current) bottomGroupRef.current.rotation.x =  openAmt.current;
    // Top jaw rotates upward       (−X, 40% range)
    if (topGroupRef.current)    topGroupRef.current.rotation.x    = -openAmt.current * 0.4;

    // Debug bars — write to global for HUD overlay to read
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, number>).__DEBUG_AMP__ = amp;
      (window as unknown as Record<string, number>).__DEBUG_MOUTH__ = openAmt.current;
    }
  });

  return (
    <>
      {/* Top hemisphere — eyes and nose are children so they tilt with it */}
      <group ref={topGroupRef}>
        <mesh>
          <sphereGeometry args={[R, 64, 64, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={HEAD_COLOR} roughness={0.25} metalness={0.05} />
        </mesh>
        {children}
      </group>

      {/* Bottom hemisphere */}
      <group ref={bottomGroupRef}>
        <mesh>
          <sphereGeometry args={[R * 0.95, 64, 64, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
          <meshStandardMaterial color={HEAD_COLOR} roughness={0.25} metalness={0.05} />
        </mesh>
      </group>
    </>
  );
}

// ── Static nose ──────────────────────────────────────────────────────────────
function Nose() {
  return (
    <mesh position={[0, 0.18, 0.95]} scale={[0.88, 1.12, 0.80]}>
      <sphereGeometry args={[0.34, 40, 40]} />
      <meshStandardMaterial color={NOSE_COLOR} roughness={0.30} metalness={0.06} />
    </mesh>
  );
}
