import { useSessionStore } from "@/store/useSessionStore";

/**
 * Fire-and-forget local vibe blurbs for the user's town (async while first jokes play).
 * Deduped per session via `townFlavorRequested`.
 */
export function kickTownFlavorFetch(): void {
  const s = useSessionStore.getState();
  if (s.townFlavorRequested || s.townFlavorBlurb) return;
  const city = s.ambientContext?.city;
  const region = s.ambientContext?.region ?? "";
  if (!city || city === "unknown") return;

  s.setTownFlavorRequested(true);
  s.logTiming("geo: town flavor fetch started");

  fetch("/api/town-flavor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, region }),
    signal: AbortSignal.timeout(12_000),
  })
    .then((r) => r.json())
    .then((d: { blurb?: string }) => {
      const blurb = d.blurb?.trim();
      if (blurb) {
        useSessionStore.getState().setTownFlavorBlurb(blurb);
        useSessionStore.getState().logTiming(`geo: town flavor ready — ${blurb.slice(0, 72)}…`);
      }
    })
    .catch(() => {
      useSessionStore.getState().logTiming("geo: town-flavor fetch failed");
    });
}
