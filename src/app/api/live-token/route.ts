import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality } from "@google/genai";
import { LIVE_MODEL, LIVE_VOICE_NAME } from "@/lib/liveConstants";
import { getLiveTranscriptionPrompt } from "@/lib/livePrompts";

/**
 * Creates an ephemeral auth token for client-side Gemini Live API connections.
 *
 * In Comedian Brain mode, Gemini Live is used for STT/VAD only.
 * The system prompt is a minimal transcription instruction.
 * All speech is handled by the ComedianBrain via ElevenLabs.
 */
export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
    }

    // Body still accepted for API compat — persona/burnIntensity no longer used
    await req.json().catch(() => ({}));

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "v1alpha" },
    });

    const token = await ai.authTokens.create({
      config: {
        uses: 2, // 1 initial + 1 for session rotation
        expireTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min
        newSessionExpireTime: new Date(Date.now() + 3 * 60 * 1000).toISOString(), // 3 min
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: getLiveTranscriptionPrompt(),
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME },
              },
            },
            // Must be in constraints — client-side additions are ignored when token is used
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        },
      },
    });

    if (!token.name) {
      return NextResponse.json({ error: "Token creation returned no name" }, { status: 500 });
    }

    return NextResponse.json({ token: token.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[live-token]", message);
    return NextResponse.json({ error: "Token creation failed" }, { status: 500 });
  }
}
