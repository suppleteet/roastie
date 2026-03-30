import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { GoogleGenAI } from "@google/genai";
import { getRoastSystemPrompt, getGreetingSystemPrompt } from "@/lib/prompts";
import { ROAST_MODEL } from "@/lib/constants";
import { extractJson } from "@/lib/jsonUtils";
import type { BurnIntensity } from "@/lib/prompts";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

type RoastSentenceRaw = { text: string; motion: string; intensity: number };

export async function POST(req: NextRequest) {
  try {
    const { imageBase64, burnIntensity = 3, mode = "roast", persona } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ error: "imageBase64 required" }, { status: 400 });
    }

    const personaId: PersonaId = PERSONA_IDS.includes(persona) ? persona : DEFAULT_PERSONA;

    // Vision-only mode: fast, focused call that returns only observations
    if (mode === "vision") {
      const response = await ai.models.generateContent({
        model: ROAST_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
              { text: `Return a JSON object with two fields:
- "person": array of 3-5 short observations (2-5 words each) about the person — expression, mood, posture, actions, accessories.
- "setting": a short confident guess about where they are based on the background (e.g. "home office", "bedroom", "kitchen", "car", "coffee shop"). If the background is too blurry or generic to tell, use null.
Example: {"person":["smirking","leaning back","wearing headphones"],"setting":"home office"}
Keep it compact. Return ONLY the JSON object.` },
            ],
          },
        ],
        config: { maxOutputTokens: 500 },
      });
      const text = response.text ?? "{}";
      const parsed = extractJson<{ person?: string[]; setting?: string | null }>(text, /\{[\s\S]*\}/, {});
      const observations = Array.isArray(parsed.person) ? parsed.person.filter((s) => typeof s === "string") : [];
      const setting = typeof parsed.setting === "string" ? parsed.setting : null;
      return NextResponse.json({ sentences: [], observations, setting });
    }

    const systemPrompt =
      mode === "greeting"
        ? getGreetingSystemPrompt(personaId)
        : getRoastSystemPrompt(burnIntensity as BurnIntensity, personaId);

    const response = await ai.models.generateContent({
      model: ROAST_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
            { text: mode === "greeting" ? "Greet and observe this person!" : "Roast this person based on what you see!" },
          ],
        },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1200,
      },
    });

    const text = response.text ?? "{}";
    const parsed = extractJson<{ observations?: string[]; sentences?: RoastSentenceRaw[] }>(
      text,
      /\{[\s\S]*\}/,
      {}
    );

    const sentences: RoastSentenceRaw[] = (parsed.sentences ?? []).filter(
      (s) => typeof s.text === "string" && s.text.trim().length > 0
    );
    const observations: string[] = parsed.observations ?? [];

    return NextResponse.json({ sentences, observations });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[analyze]", message);
    return NextResponse.json({ error: "Analyze API failed", detail: message }, { status: 500 });
  }
}
