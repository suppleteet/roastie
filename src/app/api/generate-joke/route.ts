import { NextRequest, NextResponse } from "next/server";
import { ROAST_MODEL } from "@/lib/constants";
import { getJokePrompt } from "@/lib/prompts";
import type { BurnIntensity } from "@/lib/prompts";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { MotionState } from "@/lib/motionStates";
import { getSession, getContextInstructions, sendMessage } from "@/lib/chatSessionStore";
import { QuotaError } from "@/lib/llmClient";
import { generateText, type UserPart } from "@/lib/llmClient";

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
  sessionId?: string;
  model?: string;
  persona: PersonaId;
  burnIntensity: BurnIntensity;
  contentMode?: "clean" | "vulgar";
  question?: string;
  userAnswer?: string;
  fillerAlreadySaid?: string;
  jokesAlreadyDelivered?: string[];
  observations?: string[];
  previousObservations?: string[];
  conversationSoFar?: string[];
  knownFacts?: string[];
  maxJokes?: number;
  imageBase64?: string;
  setting?: string | null;
  ambientContext?: {
    city: string;
    region: string;
    timeOfDay: string;
    localTime: string;
    weather?: string;
    tempF?: number;
    tempC?: number;
  };
  /** When set, suppresses the stock AMBIENT paragraph — avoids copy-pasting city/day/weather every joke. */
  ambientAntiRepeatNote?: string;
  /** Async local culture/vibe line — crystals, hippie town, suburbs, etc. */
  townFlavor?: string;
}

/** Build user message text from the request body. */
function buildUserText(body: GenerateJokeRequest, taskPreamble?: string): string {
  const contextLines: string[] = [];

  if (taskPreamble) contextLines.push(taskPreamble);
  if (body.question) contextLines.push(`QUESTION ASKED: "${body.question}"`);
  if (body.userAnswer) contextLines.push(`USER'S ANSWER: "${body.userAnswer}"`);
  if (body.fillerAlreadySaid) contextLines.push(`FILLER ALREADY SPOKEN: "${body.fillerAlreadySaid}" was already said aloud. Do NOT open with a similar filler sound.`);
  if (body.jokesAlreadyDelivered?.length)
    contextLines.push(`JOKES ALREADY DELIVERED THIS CYCLE:\n${body.jokesAlreadyDelivered.map((j, i) => `${i + 1}. "${j}"`).join("\n")}`);
  if (body.observations?.length)
    contextLines.push(`CURRENT OBSERVATIONS: ${body.observations.join("; ")}`);
  if (body.setting)
    contextLines.push(`SETTING: The person appears to be in their ${body.setting}.`);
  if (body.previousObservations?.length)
    contextLines.push(`PREVIOUS OBSERVATIONS: ${body.previousObservations.join("; ")}`);
  if (body.conversationSoFar?.length)
    contextLines.push(`CONVERSATION SO FAR:\n${body.conversationSoFar.slice(-6).join("\n")}`);
  if (body.knownFacts?.length)
    contextLines.push(`KNOWN FACTS: ${body.knownFacts.join(", ")}`);
  if (body.townFlavor?.trim()) {
    contextLines.push(
      `LOCAL PLACE VIBE (optional roast texture — at most one brief nod per joke; not every line): ${body.townFlavor.trim()}`,
    );
  }
  if (body.ambientAntiRepeatNote) {
    contextLines.push(body.ambientAntiRepeatNote);
  } else if (body.ambientContext) {
    const ac = body.ambientContext;
    // Use city only (no region/county). Time is vague ("on a Wednesday morning"), never exact.
    const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
    contextLines.push(`AMBIENT (use sparingly, only when funny): They're in ${ac.city} on a ${dayName} ${ac.timeOfDay}.${ac.weather ? ` Weather: ${ac.weather}.` : ""} NEVER say the exact time. Say things like "you're up this late" or "on a ${dayName} morning" or "in this weather".`);
  }
  if (body.maxJokes)
    contextLines.push(`Generate exactly ${body.maxJokes} joke(s).`);

  return contextLines.length > 0 ? contextLines.join("\n\n") : "Generate jokes based on the context.";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateJokeRequest;
    const model = body.model ?? ROAST_MODEL;

    // Try to use an existing chat session
    const session = body.sessionId ? getSession(body.sessionId) : null;

    let rawText: string;

    if (session) {
      // ── Multi-turn path: persona is in the session's system prompt ──
      const taskPreamble = getContextInstructions(body.context ?? "hopper");
      const userParts: UserPart[] = [];
      userParts.push({ text: buildUserText(body, taskPreamble) });
      if (body.imageBase64) {
        userParts.push({ inlineData: { mimeType: "image/jpeg", data: body.imageBase64 } });
      }

      rawText = await sendMessage(body.sessionId!, userParts, 512) ?? "";
    } else {
      // ── Stateless fallback: full system prompt on every request ──
      const personaId: PersonaId = PERSONA_IDS.includes(body.persona)
        ? body.persona
        : DEFAULT_PERSONA;
      const burnIntensity: BurnIntensity = ([1, 2, 3, 4, 5] as const).includes(body.burnIntensity)
        ? body.burnIntensity
        : 3;
      const contentMode = body.contentMode === "vulgar" ? "vulgar" : "clean";
      const systemPrompt = getJokePrompt(body.context ?? "hopper", personaId, burnIntensity, contentMode);

      const userParts: UserPart[] = [];
      userParts.push({ text: buildUserText(body) });
      if (body.imageBase64) {
        userParts.push({ inlineData: { mimeType: "image/jpeg", data: body.imageBase64 } });
      }

      rawText = await generateText({
        model,
        systemPrompt,
        userParts,
        maxOutputTokens: 512,
        forceJsonObject: true,
      });
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[generate-joke] No JSON in response:", rawText);
      return NextResponse.json(
        { error: "Model returned non-JSON response" },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]) as JokeResponse;

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
    if (err instanceof QuotaError) {
      console.error("[generate-joke] QUOTA:", err.message);
      return NextResponse.json(
        { error: "quota_exceeded", provider: err.provider, detail: err.message },
        { status: 402 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-joke]", message);
    return NextResponse.json(
      { error: "Joke generation failed", detail: message },
      { status: 500 }
    );
  }
}
