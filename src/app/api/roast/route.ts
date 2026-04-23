import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getRoastSystemPrompt, getGreetingSystemPrompt } from "@/lib/prompts";
import { VISION_MODEL } from "@/lib/constants";
import { extractJson } from "@/lib/jsonUtils";
import type { BurnIntensity } from "@/lib/prompts";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

type RoastSentenceRaw = { text: string; motion: string; intensity: number };

export async function POST(req: NextRequest) {
  try {
    const { scene, burnIntensity = 3, mode = "roast" } = await req.json();
    if (!scene) {
      return NextResponse.json({ error: "scene required" }, { status: 400 });
    }

    const systemPrompt = mode === "greeting"
      ? getGreetingSystemPrompt()
      : getRoastSystemPrompt(burnIntensity as BurnIntensity);

    const response = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Here is the scene description:\n${JSON.stringify(scene, null, 2)}\n\nRoast this person!`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 800,
      },
    });

    const text = response.text ?? "[]";
    const fallback: RoastSentenceRaw[] = [{ text, motion: "smug", intensity: 0.7 }];
    const sentences = extractJson<RoastSentenceRaw[]>(text, /\[[\s\S]*\]/, fallback);

    return NextResponse.json({ sentences });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[roast]", message);
    return NextResponse.json({ error: "Roast API failed", detail: message }, { status: 500 });
  }
}
