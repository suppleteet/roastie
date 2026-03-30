/**
 * Comedian Brain — all timing, threshold, and content parameters in one place.
 *
 * Tests inject short timeouts via window.__COMEDIAN_CONFIG__ before page load:
 *   window.__COMEDIAN_CONFIG__ = { answerWaitMs: 80, answerSilenceMs: 30 }
 *
 * No code changes needed — just modify this object.
 */

const defaults = {
  // Timing (milliseconds)
  answerSilenceMs: 300,          // fallback silence timer (Silero VAD is primary, ~150ms)
  answerWaitMs: 6000,            // silence before first prod
  earlyListenMs: 600,            // switch mic to listening this many ms before question ends
  visionIntervalMs: 5000,        // how often vision analyze fires
  greetingVisionTimeoutMs: 3000, // how long to wait for vision during greeting

  // Behavior
  maxProds: 2,                            // prods before skipping question
  speculativeMinWords: 1,                 // words before firing speculative generation
  hopperMaxSize: 8,                       // max jokes in hopper
  hopperMinScoreForBonus: 8,              // score threshold for unsolicited bonus jokes
  hopperMinScoreForFallback: 6,           // score threshold for silence fallback
  hopperStalenessMs: 60_000,             // evict hopper jokes older than this
  silentQuestionsBeforeVisionMode: 2,     // unanswered Qs before switching to vision-only

  // Content
  jokesPerAnswer: { min: 1, max: 2 },     // how many jokes after each answer
  jokesPerVisionOpen: { min: 1, max: 1 }, // jokes after first vision analysis (keep short, get to Q&A fast)
  callbackOpportunityEveryN: 3,           // check for callbacks every N transitions

  // Greeting pool
  generatedGreetingCount: 4,  // how many AI-generated greetings to pre-generate

  // Latency experiments (temporary)
  skipGreeting: false,         // skip greeting → jump straight to ask_question
  skipPreGeneration: true,    // skip speculative pre-generation during wait_answer
  skipFiller: true,           // skip "Hmm." / echo filler before joke delivery
  singleJokeMode: true,      // generate 1 joke at a time, pipeline next during delivery
};

const windowOverride =
  typeof window !== "undefined"
    ? (
        window as { __COMEDIAN_CONFIG__?: Partial<typeof defaults> }
      ).__COMEDIAN_CONFIG__
    : undefined;

export const COMEDIAN_CONFIG: typeof defaults = { ...defaults, ...windowOverride };
