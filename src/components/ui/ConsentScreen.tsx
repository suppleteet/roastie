"use client";
import { useSessionStore } from "@/store/useSessionStore";
import type { BurnIntensity } from "@/lib/prompts";

const INTENSITY_LABELS: Record<BurnIntensity, { label: string; desc: string; color: string }> = {
  1: { label: "Warm Hug", desc: "Gentle teasing", color: "bg-green-700 hover:bg-green-600" },
  2: { label: "Light Burn", desc: "Friendly jabs", color: "bg-lime-700 hover:bg-lime-600" },
  3: { label: "Medium Heat", desc: "Pointed roasting", color: "bg-yellow-700 hover:bg-yellow-600" },
  4: { label: "Spicy", desc: "Sharp & savage", color: "bg-orange-700 hover:bg-orange-600" },
  5: { label: "MAXIMUM BURN", desc: "Absolutely brutal", color: "bg-red-700 hover:bg-red-600" },
};

export default function ConsentScreen() {
  const burnIntensity = useSessionStore((s) => s.burnIntensity);
  const setBurnIntensity = useSessionStore((s) => s.setBurnIntensity);
  const setPhase = useSessionStore((s) => s.setPhase);

  function handleReady() {
    setPhase("requesting-permissions", "CONSENT_ACCEPTED");
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white px-6 text-center">
      <h2 className="text-4xl font-black mb-2">Set Your Burn Level</h2>
      <p className="text-gray-400 mb-8 max-w-sm">
        This is locked for the session. Choose wisely.
      </p>

      <div className="flex gap-3 mb-10 flex-wrap justify-center">
        {([1, 2, 3, 4, 5] as BurnIntensity[]).map((lvl) => {
          const cfg = INTENSITY_LABELS[lvl];
          const selected = burnIntensity === lvl;
          return (
            <button
              key={lvl}
              onClick={() => setBurnIntensity(lvl)}
              className={`flex flex-col items-center px-5 py-4 rounded-xl border-2 transition-all ${
                cfg.color
              } ${
                selected
                  ? "border-white scale-105 shadow-lg"
                  : "border-transparent opacity-70"
              }`}
            >
              <span className="text-2xl font-black">{lvl}</span>
              <span className="text-sm font-bold">{cfg.label}</span>
              <span className="text-xs text-gray-300">{cfg.desc}</span>
            </button>
          );
        })}
      </div>

      <div className="bg-gray-900 rounded-xl p-5 mb-8 max-w-sm text-left text-sm text-gray-300 space-y-2">
        <p>⚠️ <strong>Content Warning:</strong> This app generates comedic roasts. At higher intensities the content may be crude or offensive.</p>
        <p>📷 <strong>Camera Disclosure:</strong> Your webcam feed is used only to generate the roast. Frames are sent to an AI vision API. Nothing is stored.</p>
        <p>🎥 <strong>Recording:</strong> A video of the session is generated locally for sharing. It never leaves your device unless you share it.</p>
      </div>

      <button
        onClick={handleReady}
        className="px-10 py-4 bg-red-600 hover:bg-red-500 rounded-2xl text-xl font-bold transition-all transform hover:scale-105"
      >
        I&apos;m Ready — Let&apos;s Go
      </button>

      <button
        onClick={() => setPhase("idle", "CONSENT_BACK")}
        className="mt-4 text-gray-500 hover:text-gray-300 text-sm"
      >
        ← Back
      </button>
    </div>
  );
}
