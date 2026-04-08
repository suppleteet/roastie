import { NextRequest } from "next/server";
import { ELEVENLABS_VOICE_ID } from "@/lib/constants";

export async function POST(req: NextRequest) {
  try {
    const {
      text,
      voiceId: overrideVoiceId,
      voiceSettings: overrideSettings,
      previousRequestIds,
    } = await req.json();
    if (!text) {
      return new Response(JSON.stringify({ error: "text required" }), { status: 400 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not set" }), {
        status: 500,
      });
    }

    const voiceId = overrideVoiceId ?? process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_VOICE_ID;
    const voiceSettings = overrideSettings ?? {
      stability: 0.5,
      similarity_boost: 0.85,
      style: 0.4,
      use_speaker_boost: true,
    };

    // Use ElevenLabs REST streaming endpoint
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: voiceSettings,
          ...(Array.isArray(previousRequestIds) && previousRequestIds.length > 0
            ? { previous_request_ids: previousRequestIds.slice(-3) }
            : {}),
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("[tts] ElevenLabs error:", err);
      return new Response(JSON.stringify({ error: "TTS failed" }), { status: 500 });
    }

    // Forward the ElevenLabs request-id so the client can chain continuity
    const elevenLabsRequestId = response.headers.get("request-id");

    // Stream the audio back directly
    return new Response(response.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        ...(elevenLabsRequestId ? { "X-Request-Id": elevenLabsRequestId } : {}),
      },
    });
  } catch (err) {
    console.error("[tts]", err);
    return new Response(JSON.stringify({ error: "TTS failed" }), { status: 500 });
  }
}
