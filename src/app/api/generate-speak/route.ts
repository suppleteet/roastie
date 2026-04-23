import { NextRequest } from "next/server";
import { ROAST_MODEL } from "@/lib/constants";
import { getJokePrompt } from "@/lib/prompts";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { BurnIntensity } from "@/lib/prompts";
import type { JokeContext, JokeItem, JokeResponse } from "@/app/api/generate-joke/route";
import { getSession, getContextInstructions, sendMessageStream } from "@/lib/chatSessionStore";
import { generateTextStream, QuotaError, type UserPart } from "@/lib/llmClient";

type StreamEvent =
  | { type: "joke"; text: string; motion: string; intensity: number; score: number }
  | {
      type: "meta";
      relevant: boolean;
      followUp?: string;
      redirect?: string;
      tags?: string[];
      callback?: { text: string; motion: string; intensity: number };
    }
  | { type: "done" };

function sse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Extract complete flat joke objects (text+motion+intensity+score) from a partial JSON string.
 * Returns only newly found jokes beyond `emittedCount`.
 */
function extractNewJokes(accumulated: string, emittedCount: number): JokeItem[] {
  const jokes: JokeItem[] = [];
  const flatObjRegex = /\{[^{}]+\}/g;
  let match;
  while ((match = flatObjRegex.exec(accumulated)) !== null) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (
        typeof parsed.text === "string" &&
        typeof parsed.motion === "string" &&
        typeof parsed.intensity === "number" &&
        typeof parsed.score === "number"
      ) {
        jokes.push(parsed as unknown as JokeItem);
      }
    } catch {
      // malformed partial object — skip
    }
  }
  return jokes.slice(emittedCount);
}

export interface GenerateSpeakRequest {
  context: JokeContext;
  sessionId?: string;
  model?: string;
  persona?: PersonaId;
  burnIntensity?: BurnIntensity;
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
  ambientAntiRepeatNote?: string;
  townFlavor?: string;
}

/** Build user message parts from the request body. */
function buildUserParts(
  body: GenerateSpeakRequest,
  taskPreamble?: string,
): UserPart[] {
  const parts: UserPart[] = [];
  const contextLines: string[] = [];

  if (taskPreamble) contextLines.push(taskPreamble);
  if (body.question) contextLines.push(`QUESTION ASKED: "${body.question}"`);
  if (body.userAnswer) contextLines.push(`USER'S ANSWER: "${body.userAnswer}"`);
  if (body.fillerAlreadySaid) contextLines.push(`FILLER_ALREADY_SAID: "${body.fillerAlreadySaid}" — do NOT open your joke by repeating this word or phrase.`);
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
    const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
    contextLines.push(`AMBIENT (use sparingly): They're in ${ac.city} on a ${dayName} ${ac.timeOfDay}.${ac.weather ? ` Weather: ${ac.weather}.` : ""} NEVER say the exact time or location details.`);
  }
  if (body.maxJokes)
    contextLines.push(`Generate exactly ${body.maxJokes} joke(s).`);

  parts.push({ text: contextLines.length > 0 ? contextLines.join("\n\n") : "Generate jokes." });

  if (body.imageBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: body.imageBase64 } });
  }

  return parts;
}

export async function POST(req: NextRequest) {
  let body: GenerateSpeakRequest;
  try {
    body = (await req.json()) as GenerateSpeakRequest;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const model = body.model ?? ROAST_MODEL;
  const encoder = new TextEncoder();

  // Try to use an existing chat session (multi-turn — persona already loaded)
  const session = body.sessionId ? getSession(body.sessionId) : null;

  const stream = new ReadableStream({
    async start(controller) {
      let accumulated = "";
      let jokesEmitted = 0;

      try {
        let textStream: AsyncIterable<string>;

        if (session) {
          // ── Multi-turn path: persona is in the session's system prompt ──
          const taskPreamble = getContextInstructions(body.context ?? "answer_roast");
          const userParts = buildUserParts(body, taskPreamble);
          textStream = sendMessageStream(body.sessionId!, userParts);
        } else {
          // ── Stateless fallback: full system prompt on every request ──
          const personaId: PersonaId = PERSONA_IDS.includes(body.persona as PersonaId)
            ? (body.persona as PersonaId)
            : DEFAULT_PERSONA;
          const burnIntensity: BurnIntensity = ([1, 2, 3, 4, 5] as const).includes(
            body.burnIntensity as BurnIntensity,
          )
            ? (body.burnIntensity as BurnIntensity)
            : 3;
          const contentMode = body.contentMode === "vulgar" ? "vulgar" : "clean";
          const systemPrompt = getJokePrompt(body.context ?? "answer_roast", personaId, burnIntensity, contentMode);
          const userParts = buildUserParts(body);

          textStream = generateTextStream({
            model,
            systemPrompt,
            userParts,
            forceJsonObject: true,
          });
        }

        for await (const chunkText of textStream) {
          if (!chunkText) continue;
          accumulated += chunkText;

          const newJokes = extractNewJokes(accumulated, jokesEmitted);
          for (const joke of newJokes) {
            controller.enqueue(encoder.encode(sse({ type: "joke", ...joke })));
            jokesEmitted++;
          }
        }

        // Parse full response for meta fields + any jokes missed by streaming
        const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const full = JSON.parse(jsonMatch[0]) as JokeResponse;

            const remainingJokes = (Array.isArray(full.jokes) ? full.jokes : []).slice(jokesEmitted);
            for (const joke of remainingJokes) {
              controller.enqueue(encoder.encode(sse({ type: "joke", ...joke })));
              jokesEmitted++;
            }

            controller.enqueue(
              encoder.encode(
                sse({
                  type: "meta",
                  relevant: full.relevant ?? true,
                  followUp: full.followUp,
                  redirect: full.redirect,
                  tags: full.tags,
                  callback: full.callback,
                }),
              ),
            );
          } catch {
            controller.enqueue(encoder.encode(sse({ type: "meta", relevant: true })));
          }
        } else {
          controller.enqueue(encoder.encode(sse({ type: "meta", relevant: true })));
        }
      } catch (e) {
        if (e instanceof QuotaError) {
          console.error("[generate-speak] QUOTA:", e.message);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "quota_exceeded", provider: e.provider, detail: e.message })}\n\n`));
        } else {
          console.error("[generate-speak]", e);
          controller.enqueue(encoder.encode(sse({ type: "meta", relevant: true })));
        }
      }

      controller.enqueue(encoder.encode(sse({ type: "done" })));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
