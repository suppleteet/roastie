import type { JokeResponse } from "@/app/api/generate-joke/route";
import type { BurnIntensity } from "@/lib/prompts";
import type { PersonaId } from "@/lib/personas";
import type { ContentMode } from "@/store/useSessionStore";
import { useSessionStore } from "@/store/useSessionStore";

export interface GreetingPrefetchSnapshot {
  activePersona: PersonaId;
  burnIntensity: BurnIntensity;
  contentMode: ContentMode;
}

async function postJsonWithRetry<T>(
  url: string,
  payload: unknown,
  options?: { retries?: number; timeoutMs?: number },
): Promise<T | null> {
  const retries = options?.retries ?? 2;
  const timeoutMs = options?.timeoutMs ?? 5000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) return (await resp.json()) as T;
      if (attempt < retries && (resp.status === 429 || resp.status >= 500)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * Math.pow(2, attempt)));
        continue;
      }
      return null;
    } catch {
      if (attempt < retries) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * Math.pow(2, attempt)));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Parallel vision analyze + greeting joke — same contract as LiveSessionController session start.
 * Updates observations / vision setting in the session store when vision returns.
 */
export async function prefetchParallelVisionAndGreeting(
  greetingFrame: string | undefined,
  snapshot: GreetingPrefetchSnapshot,
): Promise<JokeResponse | null> {
  // Vision runs in parallel and updates the store independently — never blocks the joke.
  // 6s → 12s timeout: Gemini Flash with image cold-start can take 7-9s; aborting at 5s
  // forces a retry that costs more than the original wait.
  if (greetingFrame) {
    postJsonWithRetry<{ observations?: string[]; setting?: string | null }>(
      "/api/analyze",
      {
        imageBase64: greetingFrame,
        burnIntensity: snapshot.burnIntensity,
        mode: "vision",
        persona: snapshot.activePersona,
      },
      { retries: 1, timeoutMs: 12000 },
    ).then((visionData) => {
      if (!visionData) return;
      const observations = visionData.observations ?? [];
      const setting = visionData.setting ?? null;
      if (observations.length) {
        useSessionStore.getState().setObservations(observations);
        useSessionStore.getState().logTiming(
          `live: greeting vision — ${observations.length} obs — ${observations.join("; ").slice(0, 80)}`,
        );
      } else {
        useSessionStore.getState().logTiming("live: greeting vision — 0 obs");
      }
      if (setting) {
        useSessionStore.getState().setVisionSetting(setting);
      }
    });
  }

  // Joke timeout 6s → 15s: same cold-start reality. One retry is enough — beyond that
  // the brain falls back to its own canned greeting line, which is acceptable.
  return postJsonWithRetry<JokeResponse>(
    "/api/generate-joke",
    {
      context: "greeting",
      model: "gemini-2.5-flash",
      persona: snapshot.activePersona,
      burnIntensity: snapshot.burnIntensity,
      contentMode: snapshot.contentMode,
      observations: [],
      imageBase64: greetingFrame,
    },
    { retries: 1, timeoutMs: 15000 },
  );
}
