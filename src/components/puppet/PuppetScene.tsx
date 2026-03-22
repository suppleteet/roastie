"use client";
import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, OrbitControls } from "@react-three/drei";
import PuppetCharacter from "./PuppetCharacter";

function SceneLights() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 4, 3]} intensity={1.2} castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[-2, 2, 2]} intensity={0.5} color="#ff6030" />
    </>
  );
}

interface Props {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}

export default function PuppetScene({ canvasRef }: Props) {
  return (
    <Canvas
      ref={canvasRef}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      camera={{ position: [0, 0.2, 9.2], fov: 40 }}
      className="w-full h-full"
      shadows
    >
      <color attach="background" args={["#1a0a00"]} />
      <SceneLights />

      <Suspense fallback={null}>
        <PuppetCharacter />
        <Environment preset="studio" />
      </Suspense>

      {/* Dev only: orbit controls for positioning */}
      {process.env.NODE_ENV === "development" && (
        <OrbitControls enablePan={false} maxPolarAngle={Math.PI * 0.6} />
      )}
    </Canvas>
  );
}
