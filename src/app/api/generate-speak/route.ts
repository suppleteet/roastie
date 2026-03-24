import { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { getJokePrompt } from "@/lib/prompts";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { BurnIntensity } from "@/lib/prompts";
import type { JokeContext, JokeItem, JokeResponse } from "@/app/api/generate-joke/route";

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
  // Match any flat JSON object (no nested braces)
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
  persona?: PersonaId;
  burnIntensity?: BurnIntensity;
  question?: string;
  userAnswer?: string;
  observations?: string[];
  previousObservations?: string[];
  conversationSoFar?: string[];
  imageBase64?: string;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response("GEMINI_API_KEY not set", { status: 500 });
  }

  const body = (await req.json()) as GenerateSpeakRequest;

  const personaId: PersonaId = PERSONA_IDS.includes(body.persona as PersonaId)
    ? (body.persona as PersonaId)
    : DEFAULT_PERSONA;
  const burnIntensity: BurnIntensity = ([1, 2, 3, 4, 5] as const).includes(
    body.burnIntensity as BurnIntensity,
  )
    ? (body.burnIntensity as BurnIntensity)
    : 3;

  const systemPrompt = getJokePrompt(body.context ?? "answer_roast", personaId, burnIntensity);

  const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
    [];

  const contextLines: string[] = [];
  if (body.question) contextLines.push(`QUESTION ASKED: "${body.question}"`);
  if (body.userAnswer) contextLines.push(`USER'S ANSWER: "${body.userAnswer}"`);
  if (body.observations?.length)
    contextLines.push(`CURRENT OBSERVATIONS: ${body.observations.join("; ")}`);
  if (body.previousObservations?.length)
    contextLines.push(`PREVIOUS OBSERVATIONS: ${body.previousObservations.join("; ")}`);
  if (body.conversationSoFar?.length)
    contextLines.push(
      `CONVERSATION SO FAR:\n${body.conversationSoFar.slice(-6).join("\n")}`,
    );

  userParts.push({ text: contextLines.length > 0 ? contextLines.join("\n\n") : "Generate jokes based on the context." });

  if (body.imageBase64) {
    userParts.push({ inlineData: { mimeType: "image/jpeg", data: body.imageBase64 } });
  }

  const ai = new GoogleGenAI({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let accumulated = "";
      let jokesEmitted = 0;

      try {
        const geminiStream = await ai.models.generateContentStream({
          model: ROAST_MODEL,
          config: { systemInstruction: systemPrompt },
          contents: [{ role: "user", parts: userParts }],
        });

        for await (const chunk of geminiStream) {
          const chunkText = chunk.text ?? "";
          if (!chunkText) continue;
          accumulated += chunkText;

          // Emit any newly completed joke objects
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

            // Emit any remaining jokes not caught during streaming
            const remainingJokes = (Array.isArray(full.jokes) ? full.jokes : []).slice(
              jokesEmitted,
            );
            for (const joke of remainingJokes) {
              controller.enqueue(encoder.encode(sse({ type: "joke", ...joke })));
              jokesEmitted++;
            }

            // Emit meta
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
        console.error("[generate-speak]", e);
        controller.enqueue(encoder.encode(sse({ type: "meta", relevant: true })));
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
