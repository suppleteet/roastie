import type { BurnIntensity } from "@/lib/prompts";

// Gemini Live API model — the only model supporting bidirectional audio+video streaming.
// Gemini 3 Flash/Flash-Lite do NOT support Live API (text output only).
export const LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

// Voice for the puppet comedian — Kore is theatrical and expressive.
// Alternatives to try: "Charon" (deeper), "Aoede" (warm)
export const LIVE_VOICE_NAME = "Kore";

// Audio format specs required by Gemini Live API
export const MIC_SAMPLE_RATE = 16000; // 16kHz mono PCM input
export const OUTPUT_SAMPLE_RATE = 24000; // 24kHz mono PCM output
export const MIC_MIME_TYPE = "audio/pcm;rate=16000";

// Streaming intervals
export const WEBCAM_SEND_INTERVAL_MS = 1000; // send webcam frame every 1s (max 1fps)
export const VISION_INTERVAL_MS = 5000;      // vision analyze call every 5s (brain-driven)
export const AUDIO_CHUNK_DURATION_MS = 100; // send mic audio every 100ms
export const MIC_CHUNK_SAMPLES = MIC_SAMPLE_RATE * (AUDIO_CHUNK_DURATION_MS / 1000); // 1600

// Comedian Brain timing (defaults — overridden by comedianConfig.ts window injection in tests)
export const ANSWER_SILENCE_MS = 500;    // ms of silence = answer complete
export const ANSWER_WAIT_MS = 2000;      // ms before first prod
export const MAX_PRODS = 2;              // prods before skipping question
export const SPECULATIVE_MIN_WORDS = 3;  // words before firing speculative generation

// Session rotation — audio+video sessions cap at 2 min.
// Rotate at 90s to allow overlap for seamless handoff.
export const SESSION_ROTATE_MS = 90_000;

// Default burn intensity for live sessions
export const DEFAULT_LIVE_BURN_INTENSITY: BurnIntensity = 3;

// Canned lines for mock voice sessions (debug/dev — no API tokens burned)
export const MOCK_LINES = [
  "Oh wow. You look like you got dressed in the dark and picked your outfit from a donation bin. I've seen better fashion sense on a scarecrow, and at least the scarecrow has an excuse.",
  "I've analyzed your face with cutting-edge AI and the results came back inconclusive — which is honestly the most generous review I could give.",
  "You know what's impressive? That you showed up today. Most people with your energy would've just stayed in bed and let the ceiling fan judge them.",
  "I'm not saying you're boring, but if you were a color, you'd be the gray that comes out when you mix all the other grays together.",
];
