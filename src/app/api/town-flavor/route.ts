import { NextRequest, NextResponse } from "next/server";
import { VISION_MODEL } from "@/lib/constants";
import { generateText } from "@/lib/llmClient";

interface TownFlavorRequest {
  city?: string;
  region?: string;
}

/**
 * Fast Gemini Flash blurbs — local stereotypes/vibe for roast texture (crystals, hippies, suburb hell, etc.).
 * Called async from the client while TTS plays so later jokes can use it without blocking TTFS.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TownFlavorRequest;
    const city = body.city?.trim();
    const region = (body.region ?? "").trim();
    if (!city || city === "unknown") {
      return NextResponse.json({ blurb: "" }, { status: 400 });
    }

    const place = region ? `${city}, ${region}` : city;

    const systemPrompt = `You help a roast comedian. Output COMPACT local vibe notes for joke fodder only.

Output format: one line of short phrases separated by semicolons (no bullets, no JSON).
Include stereotypes, regional vibe, what outsiders joke about, roast angles — e.g. hippie enclave, crystal shops,
suburban strip malls, tech money, cows, yoga retreats, wine moms, military town, beach tourism, etc.
Be playful; exaggerate slightly for comedy. If unsure, lean on plausible regional clichés rather than inventing fake venues.

Hard limits: under 400 characters. Plain text only.`;

    const text = await generateText({
      model: VISION_MODEL,
      systemPrompt,
      userParts: [{ text: `Place name (from geolocation): ${place}` }],
      maxOutputTokens: 220,
    });

    const blurb = text.trim().replace(/\s+/g, " ").slice(0, 450);
    return NextResponse.json({ blurb });
  } catch (err) {
    console.error("[town-flavor]", err);
    return NextResponse.json({ blurb: "" }, { status: 500 });
  }
}
