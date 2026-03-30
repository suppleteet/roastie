import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { PERSONAS, DEFAULT_PERSONA, PERSONA_IDS, type PersonaId } from "@/lib/personas";
import type { BurnIntensity } from "@/lib/prompts";

interface RephraseRequest {
  question: string;
  persona: PersonaId;
  burnIntensity: BurnIntensity;
  knownFacts?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 500 });

    const body = (await req.json()) as RephraseRequest;
    const personaId: PersonaId = PERSONA_IDS.includes(body.persona) ? body.persona : DEFAULT_PERSONA;
    const persona = PERSONAS[personaId];

    const systemPrompt =
      `You are ${persona.name}.\n` +
      `Character voice: ${persona.toneDescription}\n\n` +
      `Rephrase the given question in your character's voice. Rules:\n` +
      `- One sentence max (two if it flows naturally)\n` +
      `- Stay in character — punchy, in-character opener\n` +
      `- If you know their name, use it naturally\n` +
      `- Do NOT make a joke or add commentary — just ask the question\n` +
      `- Return ONLY the rephrased question text, nothing else`;

    const userLines: string[] = [`Rephrase this question: "${body.question}"`];
    if (body.knownFacts?.length) {
      userLines.push(`Known facts: ${body.knownFacts.join(", ")}`);
    }

    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: ROAST_MODEL,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 80,
      },
      contents: [{ role: "user", parts: [{ text: userLines.join("\n") }] }],
    });

    const rephrased = result.text?.trim() ?? body.question;
    return NextResponse.json({ rephrased });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[rephrase-question]", message);
    // Return fallback — caller will use original question text
    return NextResponse.json({ rephrased: "" }, { status: 500 });
  }
}
