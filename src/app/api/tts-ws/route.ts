import { NextRequest } from "next/server";
import { streamElTts, type ElVoiceSettings } from "@/lib/elTtsStream";

/**
 * Streaming TTS endpoint using ElevenLabs WebSocket.
 * Used for non-LLM text: fillers, questions, prods.
 *
 * POST /api/tts-ws
 * Body: { text: string }
 * Response: SSE stream of { type: "audio", chunk: "<base64pcm>" } events
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return new Response("ELEVENLABS_API_KEY not set", { status: 500 });
  }

  let body: { text?: string; previousText?: string; voiceSettings?: Partial<ElVoiceSettings> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.text?.trim()) {
    return new Response("text required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = streamElTts({
        text: body.text!,
        previousText: body.previousText,
        voiceSettings: body.voiceSettings,
        onAudioChunk: (base64Pcm) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "audio", chunk: base64Pcm })}\n\n`),
          );
        },
        onDone: () => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`),
          );
          controller.close();
        },
        onError: (err) => {
          console.error("[tts-ws]", err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`),
          );
          controller.close();
        },
      });

      // If the client disconnects, clean up the EL WebSocket
      req.signal.addEventListener("abort", () => cleanup());
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
