/**
 * ElevenLabs WebSocket TTS streaming — server-side only.
 *
 * Opens a WebSocket to ElevenLabs' streaming input API, sends text (can be
 * chunked word-by-word), and calls `onAudioChunk` with base64 PCM as it
 * arrives. Audio starts generating before the full sentence is finished.
 *
 * Used by:
 *   - /api/generate-speak (inline LLM→TTS pipe)
 *   - /api/tts-ws (standalone TTS for fillers, questions)
 */

import WebSocket from "ws";
import { ELEVENLABS_VOICE_ID } from "@/lib/constants";

const EL_MODEL_ID = "eleven_turbo_v2_5";
const EL_OUTPUT_FORMAT = "pcm_24000"; // 16-bit PCM at 24kHz — matches OUTPUT_SAMPLE_RATE

interface ElTtsStreamOptions {
  /** Text to synthesize. Sent as a single chunk. */
  text: string;
  /** Text spoken immediately before this request — helps ElevenLabs match intonation/prosody. */
  previousText?: string;
  /** Called with each base64-encoded PCM audio chunk as it arrives. */
  onAudioChunk: (base64Pcm: string) => void;
  /** Called when all audio has been received. */
  onDone: () => void;
  /** Called on error. */
  onError: (err: Error) => void;
  /** ElevenLabs voice ID override. */
  voiceId?: string;
}

/**
 * Open an ElevenLabs WebSocket, send text, stream audio back.
 * Returns a cleanup function that closes the connection.
 */
export function streamElTts({
  text,
  previousText,
  onAudioChunk,
  onDone,
  onError,
  voiceId,
}: ElTtsStreamOptions): () => void {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    onError(new Error("ELEVENLABS_API_KEY not set"));
    return () => {};
  }

  const vid = voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? ELEVENLABS_VOICE_ID;
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${vid}/stream-input?model_id=${EL_MODEL_ID}&output_format=${EL_OUTPUT_FORMAT}&xi-api-key=${apiKey}`;

  const ws = new WebSocket(url);
  let closed = false;

  ws.on("open", () => {
    // BOS (Beginning of Stream) — init with voice settings
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.85,
          style: 0.45,
          use_speaker_boost: true,
        },
        xi_api_key: apiKey,
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        ...(previousText ? { previous_text: previousText } : {}),
      }),
    );

    // Send the actual text — trigger generation immediately
    ws.send(JSON.stringify({ text, try_trigger_generation: true }));

    // EOS (End of Stream) — flush and close generation
    ws.send(JSON.stringify({ text: "" }));
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        audio?: string;
        isFinal?: boolean;
        error?: string;
      };

      if (msg.error) {
        closed = true;
        ws.close();
        onError(new Error(`ElevenLabs WS error: ${msg.error}`));
        return;
      }

      if (msg.audio) {
        onAudioChunk(msg.audio);
      }

      if (msg.isFinal) {
        closed = true;
        ws.close();
        onDone();
      }
    } catch {
      // Non-JSON message — ignore
    }
  });

  ws.on("error", (err: Error) => {
    if (!closed) {
      closed = true;
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  });

  ws.on("close", () => {
    if (!closed) {
      closed = true;
      onDone();
    }
  });

  return () => {
    if (!closed) {
      closed = true;
      try { ws.close(); } catch { /* noop */ }
    }
  };
}

/**
 * Promise-based wrapper: send text, collect audio chunks via callback,
 * resolve when done. Useful in SSE streaming contexts.
 */
export function streamElTtsAsync(
  text: string,
  onAudioChunk: (base64Pcm: string) => void,
  voiceId?: string,
  previousText?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    streamElTts({
      text,
      previousText,
      onAudioChunk,
      onDone: resolve,
      onError: reject,
      voiceId,
    });
  });
}
