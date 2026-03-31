import { NextRequest, NextResponse } from "next/server";
import type { AmbientContext } from "@/store/useSessionStore";

interface AmbientRequest {
  lat: number;
  lon: number;
}

/** Map hour to abstract time-of-day label. */
function getTimeOfDay(hour: number): string {
  if (hour >= 0 && hour < 5) return "late night";
  if (hour >= 5 && hour < 7) return "early morning";
  if (hour >= 7 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** Format hour:minute into "2:30 AM" style. */
function formatLocalTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** WMO weather code → short description. */
function weatherDescription(code: number): string {
  if (code === 0) return "clear skies";
  if (code <= 3) return "partly cloudy";
  if (code <= 49) return "foggy";
  if (code <= 59) return "drizzling";
  if (code <= 69) return "raining";
  if (code <= 79) return "snowing";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code >= 95) return "thunderstorms";
  return "overcast";
}

export async function POST(req: NextRequest) {
  try {
    const { lat, lon } = (await req.json()) as AmbientRequest;
    if (typeof lat !== "number" || typeof lon !== "number") {
      return NextResponse.json({ error: "lat/lon required" }, { status: 400 });
    }

    // Reverse geocode via Open-Meteo geocoding (free, no key)
    const geoUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;

    const [geoResp, weatherResp] = await Promise.all([
      fetch(geoUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      fetch(weatherUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    let city = "unknown";
    let region = "";
    if (geoResp?.ok) {
      const geo = await geoResp.json();
      city = geo.city || geo.locality || geo.principalSubdivision || "unknown";
      region = geo.principalSubdivision || geo.countryName || "";
    }

    let weather: string | undefined;
    let tempF: number | undefined;
    let tempC: number | undefined;
    let weatherTimezone: string | undefined;
    if (weatherResp?.ok) {
      const w = await weatherResp.json();
      weatherTimezone = w.timezone;
      const current = w.current;
      if (current) {
        weather = weatherDescription(current.weather_code ?? 0);
        tempF = Math.round(current.temperature_2m ?? 0);
        tempC = Math.round((tempF - 32) * 5 / 9);
      }
    }

    // Approximate local time using timezone from weather API
    const now = new Date();
    let localDate = now;
    if (weatherTimezone) {
      try {
        localDate = new Date(now.toLocaleString("en-US", { timeZone: weatherTimezone }));
      } catch { /* use UTC fallback */ }
    }

    const ctx: AmbientContext = {
      city,
      region,
      timeOfDay: getTimeOfDay(localDate.getHours()),
      localTime: formatLocalTime(localDate),
      weather,
      tempF,
      tempC,
    };

    return NextResponse.json(ctx);
  } catch (err) {
    console.error("[ambient-context]", err);
    return NextResponse.json({ error: "Failed to fetch ambient context" }, { status: 500 });
  }
}
