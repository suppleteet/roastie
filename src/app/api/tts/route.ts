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
      stability: 0.72,
      similarity_boost: 0.7,
      style: 1,
      speed: 0.88,
      use_speaker_boost: true,
    };

    // Use ElevenLabs REST streaming endpoint (latency tier 3 = optimized streaming)
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`,
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
      console.error("[tts] ElevenLabs error:", response.status, err);
      if (response.status === 401 || response.status === 402 || /quota|credit|billing/i.test(err)) {
        return new Response(
          JSON.stringify({ error: "quota_exceeded", provider: "elevenlabs", detail: err }),
          { status: 402 }
        );
      }
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
