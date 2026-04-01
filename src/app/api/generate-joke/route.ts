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
  /** Jokes already delivered in this pipeline cycle — escalate/riff, don't restart */
  jokesAlreadyDelivered?: string[];
  observations?: string[];
  previousObservations?: string[];
  conversationSoFar?: string[];
  knownFacts?: string[];
  maxJokes?: number;
  imageBase64?: string;
  setting?: string | null;
  /** Ambient context from geolocation — city, time-of-day, weather */
  ambientContext?: {
    city: string;
    region: string;
    timeOfDay: string;
    localTime: string;
    weather?: string;
    tempF?: number;
    tempC?: number;
  };
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
    if (body.fillerAlreadySaid) contextLines.push(`FILLER ALREADY SPOKEN: "${body.fillerAlreadySaid}" was already said aloud as a thinking sound before your joke. Your joke follows this directly — write it as a natural continuation of that energy. Do NOT open with a similar filler sound.`);
    if (body.jokesAlreadyDelivered?.length)
      contextLines.push(`JOKES ALREADY DELIVERED THIS CYCLE:\n${body.jokesAlreadyDelivered.map((j, i) => `${i + 1}. "${j}"`).join("\n")}`);
    if (body.observations?.length)
      contextLines.push(`CURRENT OBSERVATIONS: ${body.observations.join("; ")}`);
    if (body.setting)
      contextLines.push(`SETTING: The person appears to be in their ${body.setting}. You can roast their environment if it's funny.`);
    if (body.previousObservations?.length)
      contextLines.push(`PREVIOUS OBSERVATIONS: ${body.previousObservations.join("; ")}`);
    if (body.conversationSoFar?.length)
      contextLines.push(`CONVERSATION SO FAR:\n${body.conversationSoFar.slice(-6).join("\n")}`);
    if (body.knownFacts?.length)
      contextLines.push(`KNOWN FACTS ABOUT THIS PERSON: ${body.knownFacts.join(", ")}\nTHROWBACK RULE: You may reference AT MOST 1-2 of these facts per joke, and ONLY when it makes the joke funnier. Do NOT list multiple facts as a preamble ("Tyler, from San Francisco, working in tech, with a dog..."). That's hacky. Pick ONE detail to weave in naturally, or use NONE and just roast the current answer.`);
    if (body.ambientContext) {
      const ac = body.ambientContext;
      const parts = [`AMBIENT CONTEXT (from their location — use AT MOST ONCE per session, only when funny):`];
      parts.push(`- City: ${ac.city}${ac.region ? `, ${ac.region}` : ""}`);
      parts.push(`- Time: ${ac.timeOfDay} (${ac.localTime})`);
      if (ac.weather) parts.push(`- Weather: ${ac.weather}${ac.tempF !== undefined ? ` (${ac.tempF}°F)` : ""}`);
      parts.push(`RULES: Reference time/weather ABSTRACTLY — "you're up this late", "it's pouring outside and you're doing THIS" — never say the exact time or temperature. Use the city for local-specific jokes. Don't force it — only use if it's genuinely funny.`);
      contextLines.push(parts.join("\n"));
    }
    if (body.maxJokes)
      contextLines.push(`IMPORTANT: Generate exactly ${body.maxJokes} joke(s). No more.`);

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
