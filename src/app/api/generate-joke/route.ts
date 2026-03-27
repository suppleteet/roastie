import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { getJokePrompt } from "@/lib/prompts";
import type { BurnIntensity } from "@/lib/prompts";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { MotionState } from "@/lib/motionStates";

export type JokeContext =
  | "greeting"
  | "vision_opening"
  | "answer_roast"
  | "vision_react"
  | "hopper";

export interface JokeItem {
  text: string;
  motion: MotionState;
  intensity: number;
  score: number;
}

export interface JokeResponse {
  relevant: boolean;
  jokes: JokeItem[];
  followUp?: string;
  redirect?: string;
  callback?: { text: string; motion: MotionState; intensity: number };
  tags?: string[];
}

export interface GenerateJokeRequest {
  context: JokeContext;
  persona: PersonaId;
  burnIntensity: BurnIntensity;
  contentMode?: "clean" | "vulgar";
  question?: string;
  userAnswer?: string;
  /** Filler the puppet already spoke while generating — don't open the joke by repeating it */
  fillerAlreadySaid?: string;
  observations?: string[];
  previousObservations?: string[];
  conversationSoFar?: string[];
  imageBase64?: string;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
    }

    const body = (await req.json()) as GenerateJokeRequest;

    const personaId: PersonaId = PERSONA_IDS.includes(body.persona)
      ? body.persona
      : DEFAULT_PERSONA;
    const burnIntensity: BurnIntensity = ([1, 2, 3, 4, 5] as const).includes(
      body.burnIntensity
    )
      ? body.burnIntensity
      : 3;

    const contentMode = body.contentMode === "vulgar" ? "vulgar" : "clean";
    const systemPrompt = getJokePrompt(
      body.context ?? "hopper",
      personaId,
      burnIntensity,
      contentMode,
    );

    const ai = new GoogleGenAI({ apiKey });

    // Build the user message with context data
    const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    const contextLines: string[] = [];
    if (body.question) contextLines.push(`QUESTION ASKED: "${body.question}"`);
    if (body.userAnswer) contextLines.push(`USER'S ANSWER: "${body.userAnswer}"`);
    if (body.fillerAlreadySaid) contextLines.push(`FILLER_ALREADY_SAID: "${body.fillerAlreadySaid}" — do NOT open your joke by repeating this word or phrase.`);
    if (body.observations?.length)
      contextLines.push(`CURRENT OBSERVATIONS: ${body.observations.join("; ")}`);
    if (body.previousObservations?.length)
      contextLines.push(`PREVIOUS OBSERVATIONS: ${body.previousObservations.join("; ")}`);
    if (body.conversationSoFar?.length)
      contextLines.push(`CONVERSATION SO FAR:\n${body.conversationSoFar.slice(-6).join("\n")}`);

    if (contextLines.length > 0) {
      userParts.push({ text: contextLines.join("\n\n") });
    } else {
      userParts.push({ text: "Generate jokes based on the context." });
    }

    if (body.imageBase64) {
      userParts.push({
        inlineData: { mimeType: "image/jpeg", data: body.imageBase64 },
      });
    }

    const result = await ai.models.generateContent({
      model: ROAST_MODEL,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 },
      },
      contents: [{ role: "user", parts: userParts }],
    });

    const rawText = result.text ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[generate-joke] No JSON in response:", rawText);
      return NextResponse.json(
        { error: "Model returned non-JSON response" },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]) as JokeResponse;

    // Normalize — ensure required fields exist
    const response: JokeResponse = {
      relevant: parsed.relevant ?? true,
      jokes: Array.isArray(parsed.jokes) ? parsed.jokes : [],
      followUp: parsed.followUp,
      redirect: parsed.redirect,
      callback: parsed.callback,
      tags: parsed.tags,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-joke]", message);
    return NextResponse.json(
      { error: "Joke generation failed", detail: message },
      { status: 500 }
    );
  }
}
