# RoastMe — Project Reference

## Package Versions (authoritative — check before using any API)

| Package | Version | Notes |
|---------|---------|-------|
| next | ^16.1.6 | App Router, Server Components |
| react / react-dom | ^19.0.0 | React 19 — new ref callback syntax |
| typescript | ^5 | strict mode on |
| three | ^0.175.0 | R3F peer |
| @react-three/fiber | ^9.1.2 | useFrame, Canvas |
| @react-three/drei | ^10.3.5 | useGLTF, etc. |
| @types/three | ^0.175.0 | must match three version |
| zustand | ^5.0.3 | `create<State>((set) => ...)` — NOT curried v4 form |
| @anthropic-ai/sdk | ^0.39.0 | installed but NOT used in routes yet (Gemini is) |
| @google/genai | ^1.45.0 | `new GoogleGenAI({ apiKey })` → `ai.models.generateContent()` |
| elevenlabs | ^1.57.0 | installed but TTS uses raw fetch for streaming |
| simplex-noise | ^4.0.3 | |
| tailwindcss | ^3.4.19 | |

## AI Models in Use

| Constant | Model ID | Used For |
|----------|----------|----------|
| `VISION_MODEL` | `gemini-2.5-flash` | Webcam frame analysis (`/api/vision`, `/api/analyze`) |
| `ROAST_MODEL` | `gemini-2.5-flash` | Joke generation (`/api/generate-joke`, `/api/roast`, `/api/analyze`) |
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | TTS default voice — Rachel |
| `LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | Live API STT/VAD only (`/api/live-token`) |
| `LIVE_VOICE_NAME` | `Kore` | Gemini native audio voice (used in session config) |

> `@anthropic-ai/sdk` is installed (^0.39.0) but no routes use it yet. Future model would be `claude-sonnet-4-6` or `claude-opus-4-6`. When adding Anthropic routes, confirm the current model IDs — they update frequently.

Run `/package-versions` before touching any API usage.

## Session Modes

The app supports two session modes (controlled by `sessionMode` in the store):

- **`"monologue"`**: Original mode. Discrete cycle: capture frame → Gemini vision analysis → ElevenLabs TTS → play. No mic.
- **`"conversation"`** (default): **Comedian Brain** mode. Gemini Live API is used for STT/VAD only. All speech is controlled by `ComedianBrain` state machine via `/api/generate-joke` + ElevenLabs TTS. Structured show: greeting → vision jokes → Q&A cycles → vision interrupts.

## Comedian Brain Architecture (conversation mode)

```
Gemini Live API ──── mic audio ────→ inputTranscription → ComedianBrain.onInputTranscription()
                ──── webcam ────────→ VAD context only (Gemini output DISCARDED)

ComedianBrain ──→ /api/generate-joke (Gemini Flash) → joke text + motion
             └──→ /api/tts (ElevenLabs) → gapless playback via usePcmPlayback

/api/analyze ────→ webcam observations → ComedianBrain.onVisionUpdate()
```

**Key rule**: Gemini Live output (outputTranscription, modelTurn) is DISCARDED. The brain controls all speech.

## Brain State Machine

States (in order): `greeting` → `vision_jokes` → `ask_question` → `wait_answer` → `pre_generate` → `generating` → `delivering` → `check_vision` → `vision_react` (or back to `ask_question`)

Silence states: `prodding` (after answerWaitMs with no speech), `redirecting` (irrelevant answer).

State config lives in `src/lib/comedianBrainConfig.ts`. Timing in `src/lib/comedianConfig.ts`.

## Architecture

```
src/app/api/           Next.js API routes (analyze, generate-joke, roast, tts, vision, live-token, save-transcript)
src/components/puppet/ Three.js puppet inside R3F Canvas
src/components/session/ SessionController (monologue), LiveSessionController (conversation)
src/components/audio/  AudioPlayer (monologue), useMicCapture + usePcmPlayback (conversation)
src/components/recording/ MediaRecorder + offscreen canvas compositor
src/components/ui/     Screen overlays (landing, consent, HUD, share, DebugTranscript)
src/lib/               Pure utilities, constants, prompts, personas, audioUtils, motionInference
src/lib/comedianBrain.ts   State machine class (conversation mode)
src/lib/comedianBrainConfig.ts  Declarative STATE_CONFIG map
src/lib/comedianConfig.ts  All timing/threshold tuning parameters (window-injectable for tests)
src/lib/questionBank.ts    7 questions with prod lines (hot-swappable)
src/lib/visionDiff.ts      Observation diff + interest scoring
src/store/             Zustand store (useSessionStore.ts)
public/worklets/       AudioWorklet processors (mic-capture-processor.js)
```

## Key Invariants — Do Not Violate

1. **useFrame + store**: Inside `useFrame`, ALWAYS use `useSessionStore.getState()`, never `useSessionStore(selector)`. React hooks cannot run inside rAF callbacks.
2. **API routes use Gemini**: Despite `@anthropic-ai/sdk` being installed, all current routes use `@google/genai`.
3. **ElevenLabs uses raw fetch**: TTS route uses `fetch()` to support streaming passthrough. Do not refactor to the SDK without testing streaming.
4. **Zustand v5**: `create<SessionState>((set) => ...)` — no curried form.
5. **No `any`**: strict mode is on. Comment-justify any type assertion.
6. **LiveSessionController uses getState()**: All store access in WebSocket callbacks and long-lived closures must use `useSessionStore.getState()` to avoid stale closures. Only `phase` is subscribed via selector (for lifecycle).
7. **ComedianBrain controls all speech**: In conversation mode, DO NOT route Gemini output to TTS. The brain calls `queueSpeak()` directly. Gemini Live is STT/VAD only.
8. **Mic gating**: `useMicCapture` callback checks `brain.isAudioActive()` before sending audio. Mic is `"passive"` (keeps Gemini VAD warm) in most states; only `"off"` during `greeting` and `vision_jokes`. `"listening"` in `wait_answer`, `prodding`, `pre_generate`.
9. **TTS drain detection**: LiveSessionController uses `playback.isQueueEmpty()` in a rAF loop to detect when speech finishes, then calls `brain.onTtsQueueDrained()`.

## Test Config Injection

Tests inject fast timing via `window.__COMEDIAN_CONFIG__`:
```typescript
await page.addInitScript(() => {
  (window as unknown as Record<string, unknown>).__COMEDIAN_CONFIG__ = {
    answerWaitMs: 80, answerSilenceMs: 30, maxProds: 1,
    visionIntervalMs: 200, greetingVisionTimeoutMs: 300,
  };
});
```
`ComedianBrainDriver` in `e2e/helpers/comedianBrainDriver.ts` does this automatically.

## Commands

```bash
npm run dev           # Next.js dev server
npm run typecheck     # tsc --noEmit
npm run lint          # next lint
npm test              # vitest run (single pass)
npm run test:watch    # vitest watch mode
npm run test:coverage
npm run test:e2e      # Playwright (requires dev server on :3000)
```

## Path Alias

`@/*` maps to `./src/*`. Always use `@/lib/spring` not relative paths.

## Env Vars Required

```
GEMINI_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID   (optional, defaults to Rachel)
```
