/**
 * ComedianBrain — client-side state machine that orchestrates the comedy show.
 *
 * Responsibilities:
 *   - Owns the show flow: greeting → vision jokes → Q&A cycles → vision interrupts
 *   - Calls /api/generate-joke (Gemini Flash) for all speech content
 *   - Routes generated text to ElevenLabs via queueSpeak()
 *   - Controls mic gating (listening vs passive vs off)
 *   - Maintains joke hopper and conversation ledger for callbacks
 *
 * NOT responsible for:
 *   - Gemini Live WebSocket management (LiveSessionController does that)
 *   - Audio playback (usePcmPlayback does that)
 *   - React state (uses injected getStoreState() + setters)
 */

import type { MotionState } from "@/lib/motionStates";
import type { BrainState, MicMode } from "@/lib/comedianBrainConfig";
import { STATE_CONFIG } from "@/lib/comedianBrainConfig";
import { COMEDIAN_CONFIG } from "@/lib/comedianConfig";
import { QUESTION_BANK, type ComedyQuestion } from "@/lib/questionBank";
import { diffObservations } from "@/lib/visionDiff";
import type { JokeResponse, JokeItem } from "@/app/api/generate-joke/route";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import type { BurnIntensity } from "@/lib/prompts";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ScoredJoke extends JokeItem {
  sourceContext: string;
  createdAt: number;
}

export interface LedgerEntry {
  type: "question" | "answer" | "joke" | "observation" | "reaction";
  text: string;
  timestamp: number;
  tags: string[];
}

export interface ComedianBrainDeps {
  queueSpeak: (text: string, motion?: MotionState, intensity?: number) => void;
  cancelSpeech: () => void;
  isQueueEmpty: () => boolean;
  setMotion: (state: MotionState, intensity: number) => void;
  captureFrame: () => string | undefined;
  getPersona: () => PersonaId;
  getBurnIntensity: () => BurnIntensity;
  getContentMode: () => "clean" | "vulgar";
  getObservations: () => string[];
  getVisionSetting: () => string | null;
  getAmbientContext: () => import("@/store/useSessionStore").AmbientContext | null;
  setBrainState: (state: BrainState | null) => void;
  setCurrentQuestion: (q: string | null) => void;
  setUserAnswer: (ans: string) => void;
  logTiming: (entry: string) => void;
  /** Optional: pre-seed for testing */
  initialHopper?: ScoredJoke[];
  initialLedger?: LedgerEntry[];
}

// ─── Fisher-Yates shuffle ───────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Word count helper ──────────────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Smart transcript joining ────────────────────────────────────────────────────
// Gemini sends syllable-level chunks ("Ye", "s", ", one", "dog.").
// Blind space-join produces "Ye s , one dog." — garbled. This helper joins
// intelligently: no space if the new chunk looks like a word continuation.

function smartJoin(buffer: string, chunk: string): string {
  if (!buffer) return chunk;
  if (!chunk) return buffer;

  const lastChar = buffer[buffer.length - 1];
  const firstChar = chunk[0];

  // New chunk starts with punctuation or space — no extra space needed
  if (/^[\s,;:.!?'"\-)]/.test(firstChar)) return buffer + chunk;

  // Previous buffer ends with space or opening bracket — no extra space
  if (/[\s(["']$/.test(lastChar)) return buffer + chunk;

  // Previous buffer ends with a letter and chunk starts with lowercase letter —
  // likely a word continuation ("Ye" + "s" → "Yes")
  if (/[a-zA-Z]$/.test(lastChar) && /^[a-z]/.test(firstChar)) return buffer + chunk;

  // Digit followed by digit — likely a number continuation ("4" + "2" → "42")
  if (/[0-9]$/.test(lastChar) && /^[0-9]/.test(firstChar)) return buffer + chunk;

  // Digit/letter followed by uppercase — likely compound ("3" + "D" → "3D")
  if (/[a-zA-Z0-9]$/.test(lastChar) && /^[A-Z]$/.test(chunk)) return buffer + chunk;

  // Default: add space
  return buffer + " " + chunk;
}

// ─── Levenshtein similarity (cheap approximate) ─────────────────────────────────

function isSimilarAnswer(a: string, b: string): boolean {
  const wa = wordCount(a);
  const wb = wordCount(b);
  if (Math.abs(wa - wb) > 0.2 * Math.max(wa, wb, 1)) return false;
  // Starts-with heuristic: if final answer starts with speculative snapshot, reuse it
  return b.toLowerCase().startsWith(a.toLowerCase().slice(0, Math.min(a.length, 40)));
}

// ─── ComedianBrain ──────────────────────────────────────────────────────────────

export class ComedianBrain {
  private state: BrainState = "greeting";
  private micMode: MicMode = "off";

  // Q&A state
  private shuffledQuestions: ComedyQuestion[] = [];
  private questionIndex = 0;
  private pendingFollowUp: string | null = null;
  private followUpCount = 0; // how many follow-ups asked for current topic
  private askedQuestionIds: Set<string> = new Set();
  private currentQuestion: ComedyQuestion | null = null;
  // Single-joke pipeline state
  private pipelineAnswer: string | null = null;
  private pipelineJokesDelivered = 0;
  private pipelinePreviousJokes: string[] = []; // what was already said, so pipeline doesn't repeat
  private pipelinePrefetch: { jokes: JokeItem[]; meta: { followUp?: string; tags?: string[] } | null; done: boolean } | null = null;
  private pipelinePrefetchAbort: AbortController | null = null;
  /** Pre-queued question — rephrased via LLM while last joke plays; TTS fired when rephrase resolves */
  private preQueuedQuestion: ComedyQuestion | null = null;
  /** True once rephrase resolved and queueSpeak was called */
  private preQueuedTextReady = false;
  private rephraseAbort: AbortController | null = null;
  private answerBuffer = "";
  /** Incremented each time enterGenerating fires — stale stream callbacks check this to avoid double delivery. */
  private deliveryGeneration = 0;
  private prodCount = 0;
  private consecutiveSilentQuestions = 0;
  private visionOnlyMode = false;
  private started = false;

  // Vision state
  private previousObservations: string[] = [];
  private transitionCount = 0;

  // Speculative generation
  private speculativeRequest: {
    snapshot: string;
    abort: AbortController;
    result: Promise<JokeResponse | null>;
  } | null = null;

  // Hopper
  private jokeHopper: ScoredJoke[] = [];
  private hopperAbort: AbortController | null = null;

  // Ledger
  private ledger: LedgerEntry[] = [];

  // Timers
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private prodTimer: ReturnType<typeof setTimeout> | null = null;
  private devNoteTimer: ReturnType<typeof setTimeout> | null = null;

  // Availability flags
  private micAvailable = true;
  private cameraAvailable = true;

  // Last delivered joke motion — used to match question inflection
  private lastJokeMotion: import("@/lib/motionStates").MotionState = "emphasis";
  private lastJokeIntensity = 0.75;

  // Greeting vision state
  private visionReadyForGreeting = false;
  private greetingTtsDrained = false;
  private greetingVisionTimeout: ReturnType<typeof setTimeout> | null = null;
  private visionJokePrefetch: Promise<JokeResponse | null> | null = null;

  // Deps
  private readonly deps: ComedianBrainDeps;

  constructor(deps: ComedianBrainDeps) {
    this.deps = deps;
    if (deps.initialHopper) this.jokeHopper = [...deps.initialHopper];
    if (deps.initialLedger) this.ledger = [...deps.initialLedger];
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) {
      this.deps.logTiming("brain: start() called again — ignoring (already started)");
      return;
    }
    this.started = true;

    // Always lead with name so the puppet has something personal to work with.
    // Everything else shuffles freely — avoids the show feeling like a questionnaire.
    const nameQuestion = QUESTION_BANK.find((q) => q.id === "name");
    const rest = shuffle(QUESTION_BANK.filter((q) => q.id !== "name"));
    this.shuffledQuestions = nameQuestion ? [nameQuestion, ...rest] : shuffle(QUESTION_BANK);
    this.questionIndex = 0;
    this.askedQuestionIds = new Set();
    this.followUpCount = 0;
    this.ledger = [];
    this.jokeHopper = [];
    this.transitionCount = 0;
    this.consecutiveSilentQuestions = 0;
    this.visionOnlyMode = false;
    this._cancelPipelinePrefetch();
    this._cancelRephrase();

    // Latency experiment: skip greeting entirely
    if (COMEDIAN_CONFIG.skipGreeting) {
      this.deps.logTiming("brain: skipGreeting — jumping to ask_question");
      this.enterAskQuestion();
      return;
    }

    // If vision observations are already available (pre-scanned), mark vision ready immediately
    const existingObs = this.deps.getObservations();
    if (existingObs.length > 0 && this.cameraAvailable) {
      this.deps.logTiming("brain: observations pre-loaded — greeting will use them immediately");
      this.visionReadyForGreeting = true;
    }

    this.enterGreeting();
  }

  stop(): void {
    this._clearTimers();
    this._cancelSpeculative();
    this._cancelHopper();
    this._cancelRephrase();
    this.deps.setBrainState(null);
    this.micMode = "off";
  }

  isListening(): boolean {
    return this.micMode === "listening";
  }

  /** True when mic audio should be sent to Gemini (listening OR passive warm-up) */
  isAudioActive(): boolean {
    return this.micMode !== "off";
  }

  /**
   * Called by LiveSessionController when the question TTS is nearly done.
   * Switches mic to listening early so Gemini VAD is ready before the question ends.
   */
  activateEarlyListen(): void {
    if (this.state !== "ask_question" || this.micMode === "listening") return;
    this.micMode = "listening";
    this.deps.logTiming("brain: early listen activated");
  }

  setMicAvailable(available: boolean): void {
    this.micAvailable = available;
  }

  setCameraAvailable(available: boolean): void {
    this.cameraAvailable = available;
  }

  // ─── Dev voice notes (gesture-triggered) ──────────────────────────────────────

  /** Called when vision detects thumbs-down — pauses the brain for a voice note. */
  enterDevNote(): void {
    if (!COMEDIAN_CONFIG.devNotesEnabled || this.state === "dev_note") return;
    this._clearTimers();
    this._transition("dev_note");
    this.deps.setMotion("idle", 0.3);
    this.deps.cancelSpeech();
    this.deps.logTiming("brain: dev_note — thumbs down detected, pausing");
    this.devNoteTimer = setTimeout(() => {
      this.devNoteTimer = null;
      if (this.state === "dev_note") {
        this.deps.logTiming("brain: dev_note timeout — auto-resuming");
        this._advanceFromDevNote();
      }
    }, COMEDIAN_CONFIG.devNoteTimeoutMs);
  }

  /** Called when vision detects thumbs-up — resumes the brain from dev_note. */
  resumeFromDevNote(): void {
    if (this.state !== "dev_note") return;
    this.deps.logTiming("brain: dev_note — thumbs up detected, resuming");
    this._advanceFromDevNote();
  }

  private _advanceFromDevNote(): void {
    if (this.devNoteTimer) { clearTimeout(this.devNoteTimer); this.devNoteTimer = null; }
    this.enterCheckVision();
  }

  /**
   * Called by Silero VAD when end-of-speech is detected (~100-200ms latency).
   * This fires MUCH faster than the answerSilenceMs fallback timer.
   * If we already have transcript text from Gemini, complete the answer immediately.
   */
  onVadSpeechEnd(): void {
    if (this.state !== "wait_answer" && this.state !== "pre_generate") return;
    const answer = this.answerBuffer.trim();
    if (!answer) return; // no transcript yet — let the silence timer handle it
    this.deps.logTiming(`brain: VAD speech-end → completing "${answer.slice(0, 40)}"`);
    this._clearTimers();
    this._onAnswerComplete();
  }

  /**
   * Accumulate text into the answer buffer.
   * When `finished` is true, the text is the authoritative final transcription
   * for the current speech segment — replace the buffer wholesale to fix
   * smartJoin artifacts (e.g. "4 2" → "42").
   */
  private _accumulateAnswer(text: string, finished: boolean): void {
    if (finished && text.trim()) {
      this.answerBuffer = text;
    } else {
      this.answerBuffer = smartJoin(this.answerBuffer, text);
    }
    this.deps.setUserAnswer(this.answerBuffer);
  }

  /** Called when Gemini transcribes user speech */
  onInputTranscription(text: string, finished: boolean = false): void {
    if (!text.trim()) return;

    // In prodding state: user spoke → cancel prod, return to wait_answer
    if (this.state === "prodding") {
      this.deps.cancelSpeech();
      this._clearTimers();
      this._accumulateAnswer(text, finished);
      this._transition("wait_answer");
      this._startAnswerSilenceTimer();
      return;
    }

    // Late transcription during generation — STT tokens still arriving after silence timer fired.
    if (this.state === "generating") {
      this._clearTimers();
      this.deps.cancelSpeech();
      this._accumulateAnswer(text, finished);
      this.deps.logTiming(`brain: late transcription during generating — "${text}" → buffer now "${this.answerBuffer}"`);
      if (!COMEDIAN_CONFIG.skipPreGeneration) {
        this._transition("pre_generate");
        this._cancelSpeculative();
      } else {
        this._transition("wait_answer");
      }
      this._startLateSilenceTimer();
      return;
    }

    // Passive reactions while puppet is delivering
    if (this.state === "delivering") {
      this._handleReactionText(text);
      return;
    }

    // User speaks during question TTS — buffer it so it's not lost when we enter wait_answer
    if (this.state === "ask_question") {
      this._accumulateAnswer(text, finished);
      this.deps.logTiming(`brain: early answer during ask_question — "${text}"`);
      return;
    }

    if (this.state === "wait_answer" || this.state === "pre_generate") {
      this._clearTimers();
      this._accumulateAnswer(text, finished);
      this.deps.logTiming(`brain: heard "${text}" → buffer now "${this.answerBuffer}" (${wordCount(this.answerBuffer)}w)`);

      // Start speculative generation once we have enough words
      if (
        !COMEDIAN_CONFIG.skipPreGeneration &&
        this.state === "wait_answer" &&
        wordCount(this.answerBuffer) >= COMEDIAN_CONFIG.speculativeMinWords
      ) {
        this._transition("pre_generate");
        this._startSpeculative();
      }

      this._startAnswerSilenceTimer();
    }
  }

  /** Called when vision analysis completes (even with empty observations) */
  onVisionUpdate(observations: string[]): void {
    // During greeting, flag that vision is ready and fire generation
    if (this.state === "greeting") {
      this.visionReadyForGreeting = true;
      this._maybeFireGreetingGeneration();
      return;
    }

    if (observations.length === 0) return;

    // When greeting was skipped, queue a vision joke for delivery after the current question
    if (COMEDIAN_CONFIG.skipGreeting && this.previousObservations.length === 0) {
      this.previousObservations = observations;
      this.deps.logTiming("brain: first vision with skipGreeting — queuing vision joke to hopper");
      this._generateJoke({
        context: "vision_opening",
        observations,
        knownFacts: this._getThrowbackContext(),
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      }).then((response) => {
        if (!response || response.jokes.length === 0) return;
        // Add to hopper instead of speaking immediately — avoids overlapping with question TTS
        for (const joke of response.jokes) {
          this._addToHopper(joke.text, joke.motion, joke.intensity, joke.score ?? 9);
        }
      });
    }

    // Feed hopper with new vision context
    this._fireHopperGeneration("vision", observations);

    // If stuck in check_vision (vision-only mode), re-evaluate with new observations
    if (this.state === "check_vision") {
      this.enterCheckVision();
    }
  }

  /** Called when all queued TTS has finished playing */
  onTtsQueueDrained(): void {
    switch (this.state) {
      case "greeting":
        this.greetingTtsDrained = true;
        this._maybeAdvanceFromGreeting();
        break;
      case "vision_jokes":
        this.enterAskQuestion();
        break;
      case "ask_question":
        this.enterWaitAnswer();
        break;
      case "prodding":
        // Prod finished playing with no interruption — start next prod or skip
        this.prodCount++;
        if (this.prodCount >= COMEDIAN_CONFIG.maxProds) {
          this.consecutiveSilentQuestions++;
          if (
            this.consecutiveSilentQuestions >=
            COMEDIAN_CONFIG.silentQuestionsBeforeVisionMode
          ) {
            this.visionOnlyMode = true;
          }
          this.enterCheckVision();
        } else {
          // Give them another chance before the next prod
          this._startProdTimer();
        }
        break;
      case "delivering":
        this._onDeliveringDrained();
        break;
      case "dev_note":
        break; // no-op — waiting for thumbs-up gesture
      case "redirecting":
        // After a redirect, advance to the next question — re-asking loops if the user keeps
        // giving off-topic answers (the puppet already nudged them back; move on)
        this.enterAskQuestion();
        break;
      case "vision_react":
        this.enterAskQuestion();
        break;
    }
  }

  /** Called when user barges in during speech */
  onInterrupted(): void {
    if (this.state === "delivering" || this.state === "vision_react") {
      // Log the interruption as a reaction
      this._addLedger("reaction", "[interrupted]", []);
    }
  }

  // ─── State entry methods ──────────────────────────────────────────────────────

  private enterGreeting(): void {
    this._transition("greeting");
    this.micMode = "off";
    this.greetingTtsDrained = false;
    this.visionReadyForGreeting = false;

    // Set vision timeout — if webcam frame doesn't arrive in time, generate without image
    this.greetingVisionTimeout = setTimeout(() => {
      this.visionReadyForGreeting = true;
      this._maybeFireGreetingGeneration();
    }, COMEDIAN_CONFIG.greetingVisionTimeoutMs);

    this.deps.setMotion("thinking", 0.6);
    this.deps.logTiming("brain: greeting — waiting for vision before generating");
    this._maybeFireGreetingGeneration();
  }

  /** Once vision is ready (or timed out), generate the greeting via LLM. */
  private _maybeFireGreetingGeneration(): void {
    if (!this.visionReadyForGreeting) return;
    if (this.visionJokePrefetch) return;

    if (this.greetingVisionTimeout) {
      clearTimeout(this.greetingVisionTimeout);
      this.greetingVisionTimeout = null;
    }

    const observations = this.deps.getObservations();
    const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;

    this.visionJokePrefetch = this._generateJoke({
      context: "greeting",
      observations,
      imageBase64: frame,
    });

    this.visionJokePrefetch.then((response) => {
      if (this.state !== "greeting") return;
      if (!response || response.jokes.length === 0) {
        this.deps.queueSpeak("Oh, wow. Okay. Let me get a look at you.", "energetic", 0.8);
        this._addLedger("joke", "Oh, wow. Okay. Let me get a look at you.", []);
      } else {
        for (const joke of response.jokes) {
          this.deps.queueSpeak(joke.text, joke.motion, joke.intensity);
          this._addLedger("joke", joke.text, response.tags ?? []);
          this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
          this.lastJokeIntensity = joke.intensity;
        }
      }
      this.deps.setMotion("energetic", 0.8);
    });

    this.deps.logTiming("brain: greeting generation fired" + (frame ? " (with image)" : " (no image)"));
  }

  private _maybeAdvanceFromGreeting(): void {
    if (this.greetingTtsDrained && this.visionReadyForGreeting) {
      if (this.greetingVisionTimeout) {
        clearTimeout(this.greetingVisionTimeout);
        this.greetingVisionTimeout = null;
      }
      this.visionJokePrefetch = null;
      this.enterAskQuestion();
    }
  }

  private enterVisionJokes(): void {
    this._transition("vision_jokes");
    this.deps.setMotion("thinking", 0.6);
    const observations = this.deps.getObservations();

    // Use prefetched result if available, otherwise generate fresh
    const jokePromise = this.visionJokePrefetch ?? this._generateJoke({
      context: "vision_opening",
      observations,
      imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
    });
    this.visionJokePrefetch = null;

    jokePromise.then((response) => {
      if (this.state !== "vision_jokes") return;
      if (!response || response.jokes.length === 0) {
        // No jokes — skip directly to questions rather than getting stuck
        this._transition("ask_question");
        this.enterAskQuestion();
        return;
      }
      for (const joke of response.jokes) {
        this.deps.queueSpeak(joke.text, joke.motion, joke.intensity);
        this._addLedger("joke", joke.text, response.tags ?? []);
        this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
        this.lastJokeIntensity = joke.intensity;
      }
      // Clear hopper — vision-opening jokes must not replay as Q&A bonus jokes
      this.jokeHopper = [];
      this.previousObservations = [...observations];
    });
  }

  private enterAskQuestion(sameQuestion = false): void {
    this._transition("ask_question");
    this.answerBuffer = "";
    this.prodCount = 0;
    this.deps.setUserAnswer("");

    // Determine which question to ask
    let question: ComedyQuestion | null = null;

    if (this.pendingFollowUp && !sameQuestion && this.followUpCount < 1) {
      // Ask generated follow-up (max 1 per topic, then move on)
      const followUpText = this.pendingFollowUp;
      this.pendingFollowUp = null;
      this.followUpCount++;
      this.preQueuedQuestion = null; // follow-up overrides any pre-queue
      this.currentQuestion = {
        id: "follow_up",
        question: followUpText,
        jokeContext: "Answer-driven follow-up question.",
        prodLines: [
          "Come on, I set that up perfectly.",
          "I'm waiting. The audience is waiting.",
        ],
      };
      this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
      this.deps.queueSpeak(followUpText, this.lastJokeMotion, this.lastJokeIntensity);
    } else if (sameQuestion && this.currentQuestion) {
      // Re-ask same question (after redirect)
      this.preQueuedQuestion = null;
      this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
      this.deps.queueSpeak(this.currentQuestion.question, this.lastJokeMotion, this.lastJokeIntensity);
    } else if (this.visionOnlyMode) {
      // Vision-only: no more questions, wait in check_vision for interesting changes
      this._transition("check_vision");
      this.deps.logTiming("brain: vision-only mode, waiting for interesting vision change");
      this.deps.setMotion("idle", 0.3);
      return;
    } else if (this.preQueuedQuestion) {
      // Rephrase was fired speculatively — consume it
      this.pendingFollowUp = null;
      this.followUpCount = 0;
      question = this.preQueuedQuestion;
      const wasReady = this.preQueuedTextReady;
      this.preQueuedQuestion = null; // clear so stale rephrase callbacks bail out
      this.preQueuedTextReady = false;
      this.askedQuestionIds.add(question.id);
      this.currentQuestion = question;
      if (wasReady) {
        // Rephrase finished and TTS is already in the chain — gapless
        this.deps.logTiming("brain: using pre-queued question (zero wait)");
      } else {
        // Rephrase didn't finish in time — fall back to original text immediately
        this.deps.logTiming("brain: rephrase not ready — using original question text");
        this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
        this.deps.queueSpeak(question.question, this.lastJokeMotion, this.lastJokeIntensity);
      }
    } else {
      // Clear follow-up state — new topic
      this.pendingFollowUp = null;
      this.followUpCount = 0;

      // Find next question, skipping any excluded by previously asked questions
      question = this._nextValidQuestion();
      if (!question) {
        // All questions exhausted — fall to vision-only mode, wait for interesting changes
        this.visionOnlyMode = true;
        this._transition("check_vision");
        this.deps.logTiming("brain: all questions exhausted, entering vision-only mode");
        this.deps.setMotion("idle", 0.3);
        return;
      }
      this.askedQuestionIds.add(question.id);
      this.currentQuestion = question;
      // Queue TTS — not pre-queued
      this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
      this.deps.queueSpeak(this.currentQuestion.question, this.lastJokeMotion, this.lastJokeIntensity);
    }

    if (!this.currentQuestion) return;

    this.deps.setCurrentQuestion(this.currentQuestion.question);
    this._addLedger("question", this.currentQuestion.question, []);
  }

  private enterWaitAnswer(): void {
    this._transition("wait_answer");
    this.deps.setMotion("listening", 0.5);

    // If user already spoke during ask_question, start silence timer (not prod timer)
    if (this.answerBuffer.trim()) {
      this.deps.logTiming(`brain: wait_answer with pre-buffered answer — "${this.answerBuffer}"`);
      if (!COMEDIAN_CONFIG.skipPreGeneration && wordCount(this.answerBuffer) >= COMEDIAN_CONFIG.speculativeMinWords) {
        this._transition("pre_generate");
        this._startSpeculative();
      }
      this._startAnswerSilenceTimer();
      return;
    }

    this._startAnswerTimers();
  }

  private _startAnswerTimers(): void {
    if (!this.micAvailable) {
      // Skip directly to check_vision after a short delay
      this.silenceTimer = setTimeout(() => {
        this.consecutiveSilentQuestions++;
        this._transition("check_vision");
        this.enterCheckVision();
      }, 1000);
      return;
    }
    this._startProdTimer();
  }

  private _startProdTimer(): void {
    this._clearTimers();
    this.silenceTimer = setTimeout(() => {
      if (this.state === "wait_answer" || this.state === "pre_generate") {
        this.enterProdding();
      }
    }, COMEDIAN_CONFIG.answerWaitMs);
  }

  private _startAnswerSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.state === "wait_answer" || this.state === "pre_generate") {
        this._onAnswerComplete();
      }
    }, COMEDIAN_CONFIG.answerSilenceMs);
  }

  /** Shorter silence window used after late-transcription bounces — STT is clearly ending. */
  private _startLateSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.state === "wait_answer" || this.state === "pre_generate") {
        this._onAnswerComplete();
      }
    }, Math.round(COMEDIAN_CONFIG.answerSilenceMs / 2));
  }

  private enterProdding(): void {
    const q = this.currentQuestion;
    if (!q) return;
    const prodLine = q.prodLines[this.prodCount % q.prodLines.length];
    this._transition("prodding");
    this.deps.queueSpeak(prodLine, "conspiratorial", 0.5);
  }

  private _onAnswerComplete(): void {
    const answer = this.answerBuffer.trim();
    if (!answer) {
      this.enterProdding();
      return;
    }
    this.enterGenerating(answer);
  }

  // Short non-word filler reactions — play immediately when generating starts so there's no dead air.
  // These are speculative/thinking sounds that bridge naturally into the joke via ElevenLabs vocal continuity.
  private static readonly GENERATING_FILLERS = [
    "Mmm.", "Hm.", "Uh huh.", "Hmm.", "Mmhmm.", "Ohhh.", "Huh.",
  ];

  private enterGenerating(answer: string): void {
    this._transition("generating");
    this.deliveryGeneration++;
    this.deps.setMotion("thinking", 0.7);
    this._addLedger("answer", answer, []);

    // Queue an immediate non-word filler so the user hears something right away while the API generates.
    // These short sounds ("Mmm.", "Uh huh.") bridge the silence and set the vocal tone for the joke
    // via ElevenLabs previous_text continuity — no extra latency.
    let fillerAlreadySaid: string | undefined;
    if (!COMEDIAN_CONFIG.skipFiller) {
      const filler = ComedianBrain.GENERATING_FILLERS[Math.floor(Math.random() * ComedianBrain.GENERATING_FILLERS.length)];
      this.deps.queueSpeak(filler, "thinking", 0.6);
      this.deps.logTiming(`brain: filler — "${filler}"`);
      fillerAlreadySaid = filler;
    }

    const q = this.currentQuestion;
    const conversationSoFar = this._getLedgerContext();

    // Check if speculative result is still usable
    const spec = this.speculativeRequest;
    if (spec && isSimilarAnswer(spec.snapshot, answer)) {
      this.deps.logTiming(`brain: reusing speculative (snapshot="${spec.snapshot.slice(0, 30)}")`);
      // Reuse speculative result — but fall back to fresh if it returned empty
      spec.result.then((response) => {
        if (this.state !== "generating") return;
        this._speculativeRequest = null;
        if (response && response.jokes.length > 0) {
          this.enterDelivering(answer, response);
        } else {
          // Speculative returned empty — generate fresh
          this.deps.logTiming("brain: speculative returned empty, generating fresh");
          this._generateAndDeliver(answer, q, conversationSoFar, fillerAlreadySaid);
        }
      }).catch(() => {
        // Speculative failed — generate fresh
        if (this.state !== "generating") return;
        this._generateAndDeliver(answer, q, conversationSoFar, fillerAlreadySaid);
      });
      this._cancelSpeculative(); // clear the ref (result promise still resolves)
    } else {
      // Cancel stale speculative, generate fresh
      this._cancelSpeculative();
      this._generateAndDeliver(answer, q, conversationSoFar, fillerAlreadySaid);
    }
  }

  // Workaround: TypeScript doesn't allow assigning to private field via underscore alias
  private set _speculativeRequest(v: typeof this.speculativeRequest) {
    this.speculativeRequest = v;
  }

  private _generateAndDeliver(
    answer: string,
    q: ComedyQuestion | null,
    conversationSoFar: string[],
    fillerAlreadySaid?: string,
  ): void {
    let jokesQueued = 0;
    let metaHandled = false;
    const gen = this.deliveryGeneration; // snapshot — stale callbacks check this

    // Track answer for single-joke pipeline
    if (COMEDIAN_CONFIG.singleJokeMode) {
      this.pipelineAnswer = answer;
      this.pipelineJokesDelivered = 0;
      this.pipelinePreviousJokes = [];
    }

    this._generateJokeStream(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: answer,
        fillerAlreadySaid,
        conversationSoFar,
        knownFacts: this._getThrowbackContext(),
        maxJokes: COMEDIAN_CONFIG.singleJokeMode ? 1 : undefined,
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      },
      // onJoke — fires immediately as each joke streams in
      (joke) => {
        if (this.deliveryGeneration !== gen) return; // stale stream — ignore
        if (this.state !== "generating" && this.state !== "delivering") return;
        if (this.state === "generating") {
          // First joke arrived — transition to delivering now
          this._transition("delivering");
          this.deps.setMotion("energetic", 0.8);
        }
        this.deps.queueSpeak(joke.text, joke.motion as import("@/lib/motionStates").MotionState, joke.intensity);
        if (COMEDIAN_CONFIG.singleJokeMode) this.pipelinePreviousJokes.push(joke.text);

        this._addLedger("joke", joke.text, []);
        this.deps.logTiming(`brain: joke[${jokesQueued}] — "${joke.text.slice(0, 60)}"`);
        this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
        this.lastJokeIntensity = joke.intensity;
        jokesQueued++;
      },
      // onMeta — fires after all jokes stream, with follow-up/redirect/tags/callback
      (meta) => {
        if (this.deliveryGeneration !== gen) return; // stale stream — ignore
        if (this.state !== "generating" && this.state !== "delivering") return;
        metaHandled = true;
        this.deps.logTiming(`brain: api meta — relevant=${meta.relevant} jokes=${jokesQueued} followUp=${!!meta.followUp} redirect=${!!meta.redirect}`);

        if (!meta.relevant && meta.redirect) {
          if (jokesQueued > 0) {
            // A joke already streamed and is playing — don't queue the redirect on top of it.
            // The joke addressed the irrelevancy; let it finish and advance normally.
            this.deps.logTiming("brain: irrelevant but joke already delivered — advancing (no redirect)");
            return;
          }
          // No joke played yet — redirect immediately
          if (this.state === "generating") {
            this._transition("delivering");
            this.deps.setMotion("energetic", 0.8);
          }
          this.deps.queueSpeak(meta.redirect, "smug", 0.7);
          this._addLedger("joke", meta.redirect, []);
          this._transition("redirecting");
          return;
        }

        // Ensure we're in delivering state (no jokes may have arrived if API was fast)
        if (this.state === "generating") {
          this._transition("delivering");
          this.deps.setMotion("energetic", 0.8);
        }

        if (meta.followUp) this.pendingFollowUp = meta.followUp;
        if (meta.tags?.length) this._addLedger("answer", answer, meta.tags);

        if (meta.callback) {
          this.deps.queueSpeak(
            meta.callback.text,
            meta.callback.motion as import("@/lib/motionStates").MotionState,
            meta.callback.intensity,
          );
          this._addLedger("joke", meta.callback.text, []);
          jokesQueued++;
        }

        if (jokesQueued === 0) {
          // API returned relevant but no jokes — advance without playing unrelated content
          this.deps.logTiming("brain: stream delivered nothing — advancing to next question");
          this._onDeliveringDrained();
          return;
        }

        // Bonus hopper joke — skip in singleJokeMode (pipeline handles sequencing)
        if (!COMEDIAN_CONFIG.singleJokeMode && this.transitionCount % 4 === 0) {
          const bonus = this._popHopperJoke(COMEDIAN_CONFIG.hopperMinScoreForBonus);
          if (bonus) {
            this.deps.queueSpeak(bonus.text, bonus.motion, bonus.intensity);
            this._addLedger("joke", bonus.text, []);
            jokesQueued += 1;
          }
        }

        this._fireHopperGeneration("answer", undefined, answer);

        // Speculatively prefetch next pipeline joke while current TTS plays
        this._prefetchPipelineJoke();
      },
      // onError — stream failed, fall back to non-streaming
      () => {
        if (this.deliveryGeneration !== gen) return; // stale stream
        if (metaHandled) return;
        if (this.state !== "generating") return;
        this.deps.logTiming("brain: stream failed, generating fresh");
        this._generateJoke({
          context: "answer_roast",
          question: q?.question,
          userAnswer: answer,
          fillerAlreadySaid,
          conversationSoFar,
          imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
        }).then((response) => {
          if (this.state !== "generating") return;
          this.enterDelivering(answer, response ?? { relevant: true, jokes: [] });
        });
      },
    );
  }

  private enterDelivering(answer: string, response: JokeResponse): void {
    this._transition("delivering");
    this.deps.setMotion("energetic", 0.8);

    if (!response.relevant && response.redirect) {
      // Irrelevant answer — play redirect and re-ask
      this.deps.queueSpeak(response.redirect, "smug", 0.7);
      this._addLedger("joke", response.redirect, []);
      this._transition("redirecting");
      return;
    }

    // Store follow-up for next cycle
    if (response.followUp) {
      this.pendingFollowUp = response.followUp;
    }

    // Log tags to ledger
    if (response.tags?.length) {
      this._addLedger("answer", answer, response.tags);
    }

    let queued = 0;

    // Check for a callback
    if (response.callback) {
      this.deps.queueSpeak(response.callback.text, response.callback.motion, response.callback.intensity);
      this._addLedger("joke", response.callback.text, []);
      queued++;
    }

    // Queue all jokes
    for (const joke of response.jokes) {
      this.deps.queueSpeak(joke.text, joke.motion, joke.intensity);
      this._addLedger("joke", joke.text, []);
      queued++;
    }

    // Nothing was queued — advance immediately (don't wait for TTS drain that will never come)
    if (queued === 0) {
      this.deps.logTiming("brain: enterDelivering with nothing to say — advancing");
      this._onDeliveringDrained();
      return;
    }

    // Bonus hopper joke — only attach when there are real jokes to accompany it
    // Skip transitionCount=0 (first delivery) to avoid firing before the hopper is meaningfully populated
    if (this.transitionCount > 0 && this.transitionCount % 4 === 0) {
      const bonus = this._popHopperJoke(COMEDIAN_CONFIG.hopperMinScoreForBonus);
      if (bonus) {
        this.deps.queueSpeak(bonus.text, bonus.motion, bonus.intensity);
        this._addLedger("joke", bonus.text, []);
        queued += 1;
      }
    }

    // Feed hopper with this context
    this._fireHopperGeneration("answer", undefined, answer);
  }

  private _onDeliveringDrained(): void {
    this.transitionCount++;

    // Single-joke pipeline: generate the next joke while delivering
    if (COMEDIAN_CONFIG.singleJokeMode && this.pipelineAnswer) {
      this.pipelineJokesDelivered++;
      const maxJokesPerAnswer = COMEDIAN_CONFIG.jokesPerAnswer.max;
      if (this.pipelineJokesDelivered < maxJokesPerAnswer) {
        this.deps.logTiming(`brain: pipeline next joke (${this.pipelineJokesDelivered + 1}/${maxJokesPerAnswer})`);
        this._pipelineNextJoke();
        return;
      }
      // Done with this answer's pipeline
      this.pipelineAnswer = null;
      this._cancelPipelinePrefetch();
    }

    // Follow-up takes priority over next question
    if (this.pendingFollowUp) {
      this.enterAskQuestion();
      return;
    }

    this.enterCheckVision();
  }

  /** Generate the next pipelined joke for the current answer. */
  private _pipelineNextJoke(): void {
    const answer = this.pipelineAnswer;
    if (!answer) return;

    // Check if prefetch completed while current joke was playing
    const prefetch = this.pipelinePrefetch;
    if (prefetch?.done && prefetch.jokes.length > 0) {
      this.deps.logTiming("brain: using prefetched pipeline joke (zero wait)");
      this.pipelinePrefetch = null;
      this.pipelinePrefetchAbort = null;

      this._transition("delivering");
      this.deps.setMotion("energetic", 0.8);
      for (const joke of prefetch.jokes) {
        this.deps.queueSpeak(joke.text, joke.motion as import("@/lib/motionStates").MotionState, joke.intensity);
        this.pipelinePreviousJokes.push(joke.text);
        this._addLedger("joke", joke.text, []);
        this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
        this.lastJokeIntensity = joke.intensity;
      }
      if (prefetch.meta?.followUp) this.pendingFollowUp = prefetch.meta.followUp;
      if (prefetch.meta?.tags?.length) this._addLedger("answer", answer, prefetch.meta.tags);
      return;
    }

    // Prefetch not ready or failed — generate fresh (streaming)
    this._cancelPipelinePrefetch();
    this._transition("generating");
    this.deliveryGeneration++;
    this.deps.setMotion("thinking", 0.7);

    const q = this.currentQuestion;
    const conversationSoFar = this._getLedgerContext();
    const gen = this.deliveryGeneration;

    const alreadyDelivered = this.pipelinePreviousJokes.length > 0
      ? [...this.pipelinePreviousJokes]
      : undefined;

    this._generateJokeStream(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: answer,
        jokesAlreadyDelivered: alreadyDelivered,
        conversationSoFar,
        knownFacts: this._getThrowbackContext(),
        maxJokes: 1,
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      },
      (joke) => {
        if (this.deliveryGeneration !== gen) return;
        if (this.state !== "generating" && this.state !== "delivering") return;
        if (this.state === "generating") {
          this._transition("delivering");
          this.deps.setMotion("energetic", 0.8);
        }
        this.deps.queueSpeak(joke.text, joke.motion as import("@/lib/motionStates").MotionState, joke.intensity);
        this.pipelinePreviousJokes.push(joke.text);
        this._addLedger("joke", joke.text, []);
        this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
        this.lastJokeIntensity = joke.intensity;
      },
      (meta) => {
        if (this.deliveryGeneration !== gen) return;
        if (this.state !== "generating" && this.state !== "delivering") return;
        if (this.state === "generating") {
          this._transition("delivering");
          this.deps.setMotion("energetic", 0.8);
        }
        if (meta.followUp) this.pendingFollowUp = meta.followUp;
        if (meta.tags?.length) this._addLedger("answer", answer, meta.tags);
        // This is the last pipeline joke — pre-queue next question for gapless transition
        this._preQueueNextQuestion();
      },
      () => {
        if (this.deliveryGeneration !== gen) return;
        if (this.state === "generating") {
          this.pipelineAnswer = null;
          this._onDeliveringDrained();
        }
      },
    );
  }

  /** Pre-queue the next question's TTS while the current joke is still playing.
   *  Calls queueSpeak immediately so TTS is already streaming when the joke finishes — no gap. */
  private _preQueueNextQuestion(): void {
    if (this.pendingFollowUp) return;
    if (this.visionOnlyMode) return;

    const q = this._nextValidQuestion();
    if (!q) return;

    this.preQueuedQuestion = q;
    this.preQueuedTextReady = true;
    this.deps.queueSpeak(q.question, this.lastJokeMotion, this.lastJokeIntensity);
    this.deps.logTiming(`brain: pre-queued next question TTS: "${q.question.slice(0, 40)}"`);
  }

  private _cancelRephrase(): void {
    if (this.rephraseAbort) {
      this.rephraseAbort.abort();
      this.rephraseAbort = null;
    }
    this.preQueuedQuestion = null;
    this.preQueuedTextReady = false;
  }

  /** Speculatively generate the next pipeline joke while the current one plays. */
  private _prefetchPipelineJoke(): void {
    if (!COMEDIAN_CONFIG.singleJokeMode || !this.pipelineAnswer) return;
    const maxJokes = COMEDIAN_CONFIG.jokesPerAnswer.max;
    // If this is the last pipeline joke, pre-queue next question TTS for gapless transition
    if (this.pipelineJokesDelivered + 1 >= maxJokes) {
      this._preQueueNextQuestion();
      return;
    }

    this._cancelPipelinePrefetch();
    const abort = new AbortController();
    this.pipelinePrefetchAbort = abort;

    const prefetch: NonNullable<typeof this.pipelinePrefetch> = { jokes: [], meta: null, done: false };
    this.pipelinePrefetch = prefetch;

    const answer = this.pipelineAnswer;
    const q = this.currentQuestion;
    const alreadyDelivered = this.pipelinePreviousJokes.length > 0
      ? [...this.pipelinePreviousJokes]
      : undefined;

    this.deps.logTiming("brain: prefetching next pipeline joke while current plays");

    // Use non-streaming _generateJoke for simplicity — result stashed for _pipelineNextJoke
    this._generateJoke(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: answer,
        jokesAlreadyDelivered: alreadyDelivered,
        conversationSoFar: this._getLedgerContext(),
        knownFacts: this._getThrowbackContext(),
        maxJokes: 1,
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      },
      abort.signal,
    ).then((response) => {
      if (abort.signal.aborted || !response) return;
      prefetch.jokes = response.jokes;
      prefetch.meta = { followUp: response.followUp, tags: response.tags };
      prefetch.done = true;
      this.deps.logTiming(`brain: pipeline prefetch ready (${response.jokes.length} jokes)`);
    }).catch(() => { /* aborted or failed — _pipelineNextJoke falls back to fresh generation */ });
  }

  private _cancelPipelinePrefetch(): void {
    if (this.pipelinePrefetchAbort) {
      this.pipelinePrefetchAbort.abort();
      this.pipelinePrefetchAbort = null;
    }
    this.pipelinePrefetch = null;
  }

  private enterCheckVision(): void {
    this._transition("check_vision");
    const current = this.deps.getObservations();

    if (this.cameraAvailable && current.length > 0) {
      const oldObservations = [...this.previousObservations];
      const { isInteresting, changes } = diffObservations(oldObservations, current);
      // Always update baseline — prevents diff accumulation from wording variation
      this.previousObservations = [...current];
      if (isInteresting) {
        this.enterVisionReact(changes, current, oldObservations);
        return;
      }
    }

    // Nothing interesting — next question (unless we've exhausted all questions)
    if (this.visionOnlyMode) {
      // All questions used up and vision isn't interesting — wait for next vision update
      this.deps.logTiming("brain: vision-only mode, waiting for interesting vision change");
      this.deps.setMotion("idle", 0.3);
      return;
    }
    this.enterAskQuestion();
  }

  private enterVisionReact(changes: string[], currentObs: string[], oldObs: string[]): void {
    this._transition("vision_react");
    this.deps.setMotion("shocked", 0.8);
    const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;

    // Check hopper for a vision joke first
    const hopperJoke = this._popHopperJoke(4, "vision");
    if (hopperJoke) {
      this.deps.queueSpeak(hopperJoke.text, hopperJoke.motion, hopperJoke.intensity);
      this._addLedger("joke", hopperJoke.text, []);
      return;
    }

    this._generateJoke({
      context: "vision_react",
      observations: currentObs,
      previousObservations: oldObs,
      knownFacts: this._getThrowbackContext(),
      imageBase64: frame,
    }).then((response) => {
      if (this.state !== "vision_react") return;
      if (!response || response.jokes.length === 0) {
        // No jokes — fall through to next question rather than getting stuck
        this._transition("ask_question");
        this.enterAskQuestion();
        return;
      }
      for (const joke of response.jokes) {
        this.deps.queueSpeak(joke.text, joke.motion, joke.intensity);
        this._addLedger("joke", joke.text, []);
      }
    });
  }

  // ─── Speculative pre-generation ───────────────────────────────────────────────

  private _startSpeculative(): void {
    if (COMEDIAN_CONFIG.skipPreGeneration) return;
    const snapshot = this.answerBuffer.trim();
    if (this.speculativeRequest) {
      // Already running — if snapshot changed significantly, cancel and restart
      if (!isSimilarAnswer(this.speculativeRequest.snapshot, snapshot)) {
        this._cancelSpeculative();
      } else {
        return;
      }
    }

    const abort = new AbortController();
    const q = this.currentQuestion;
    const conversationSoFar = this._getLedgerContext();

    // Filler will be a non-word sound — tell the generator so the joke doesn't open similarly
    const fillerAlreadySaid = COMEDIAN_CONFIG.skipFiller ? undefined : "filler sound";

    const result = this._generateJoke(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: snapshot,
        fillerAlreadySaid,
        conversationSoFar,
        knownFacts: this._getThrowbackContext(),
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      },
      abort.signal,
    );

    this.speculativeRequest = { snapshot, abort, result };
  }

  private _cancelSpeculative(): void {
    if (this.speculativeRequest) {
      this.speculativeRequest.abort.abort();
      this.speculativeRequest = null;
    }
  }

  // ─── Joke Hopper ──────────────────────────────────────────────────────────────

  private _fireHopperGeneration(
    sourceContext: string,
    observations?: string[],
    answer?: string,
  ): void {
    // Cancel stale hopper generation
    this._cancelHopper();

    const abort = new AbortController();
    this.hopperAbort = abort;

    const conversationSoFar = this._getLedgerContext();

    this._generateJoke(
      {
        context: "hopper",
        observations: observations ?? this.deps.getObservations(),
        userAnswer: answer,
        conversationSoFar,
        knownFacts: this._getThrowbackContext(),
      },
      abort.signal,
    ).then((response) => {
      if (abort.signal.aborted || !response) return;
      this.hopperAbort = null;

      const now = Date.now();
      const newJokes: ScoredJoke[] = response.jokes.map((j) => ({
        ...j,
        sourceContext,
        createdAt: now,
      }));

      // Merge into hopper, evict oldest if over max
      this.jokeHopper = [
        ...this.jokeHopper.filter(
          (j) => now - j.createdAt < COMEDIAN_CONFIG.hopperStalenessMs
        ),
        ...newJokes,
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, COMEDIAN_CONFIG.hopperMaxSize);
    });
  }

  private _cancelHopper(): void {
    if (this.hopperAbort) {
      this.hopperAbort.abort();
      this.hopperAbort = null;
    }
  }

  /** Add a single joke to the hopper directly (e.g. vision opening when greeting is skipped). */
  private _addToHopper(text: string, motion: MotionState, intensity: number, score: number): void {
    this.jokeHopper.push({
      text, motion, intensity, score,
      sourceContext: "vision",
      createdAt: Date.now(),
    });
    this.jokeHopper.sort((a, b) => b.score - a.score);
    if (this.jokeHopper.length > COMEDIAN_CONFIG.hopperMaxSize) {
      this.jokeHopper.length = COMEDIAN_CONFIG.hopperMaxSize;
    }
  }

  /** Pop the best joke from the hopper meeting the minimum score, optionally filtered by context */
  private _popHopperJoke(minScore: number, contextFilter?: string): ScoredJoke | null {
    const now = Date.now();
    const idx = this.jokeHopper.findIndex(
      (j) =>
        j.score >= minScore &&
        now - j.createdAt < COMEDIAN_CONFIG.hopperStalenessMs &&
        (contextFilter ? j.sourceContext.includes(contextFilter) : true)
    );
    if (idx === -1) return null;
    const [joke] = this.jokeHopper.splice(idx, 1);
    return joke;
  }

  // ─── Passive reaction handling ────────────────────────────────────────────────

  private _handleReactionText(text: string): void {
    const lower = text.toLowerCase();
    const isLaughter = /ha|hehe|lol|haha/.test(lower);

    if (isLaughter) {
      this._addLedger("reaction", text, ["reaction:laughter"]);
      // Fire a topper from the hopper
      this._fireHopperGeneration("riff_on_reaction");
    } else if (text.trim().split(/\s+/).length <= 5) {
      // Short verbal reaction
      this._addLedger("reaction", text, ["reaction:verbal"]);
    }
  }

  // ─── Ledger ───────────────────────────────────────────────────────────────────

  private _addLedger(
    type: LedgerEntry["type"],
    text: string,
    tags: string[],
  ): void {
    this.ledger.push({ type, text, timestamp: Date.now(), tags });
    // Keep last 30 entries
    if (this.ledger.length > 30) this.ledger = this.ledger.slice(-30);
  }

  /** IDs of questions to skip when ambient context provides location. */
  private static readonly LOCATION_QUESTION_IDS = new Set(["hometown", "city"]);

  /** Returns the next valid question, skipping excluded ones. Null if exhausted. */
  private _nextValidQuestion(): ComedyQuestion | null {
    const total = this.shuffledQuestions.length;
    const ambientCity = this.deps.getAmbientContext()?.city;
    const hasLocation = !!ambientCity && ambientCity !== "unknown";

    for (let i = 0; i < total; i++) {
      const q = this.shuffledQuestions[(this.questionIndex + i) % total];
      // Skip if already asked
      if (this.askedQuestionIds.has(q.id)) continue;
      // Skip location questions when we already know their city
      if (hasLocation && ComedianBrain.LOCATION_QUESTION_IDS.has(q.id)) continue;
      // Skip if excluded by a previously asked question
      const excluded = this.shuffledQuestions
        .filter((prev) => this.askedQuestionIds.has(prev.id) && prev.excludes)
        .flatMap((prev) => prev.excludes!);
      if (excluded.includes(q.id)) continue;
      this.questionIndex += i + 1;
      return q;
    }
    return null;
  }

  private _getLedgerContext(): string[] {
    return this.ledger.slice(-6).map(
      (e) => `[${e.type}] ${e.text}${e.tags.length ? ` (${e.tags.join(", ")})` : ""}`
    );
  }

  /** Full ledger summary for throwback references — all facts learned so far. */
  private _getThrowbackContext(): string[] {
    // Extract all tagged facts (name, job, city, etc.) from the full ledger
    const facts: string[] = [];
    for (const entry of this.ledger) {
      if (entry.tags.length > 0) {
        facts.push(...entry.tags);
      }
    }
    // Add ambient context city as a known fact if available
    const ambient = this.deps.getAmbientContext();
    if (ambient?.city && ambient.city !== "unknown") {
      facts.push(`city:${ambient.city}`);
      if (ambient.region) facts.push(`region:${ambient.region}`);
    }
    return [...new Set(facts)]; // dedupe
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private _transition(next: BrainState): void {
    const config = STATE_CONFIG[next];
    this.state = next;
    this.micMode = config.micMode;
    this.deps.setBrainState(next);
    this.deps.logTiming(`brain: → ${next}`);
  }

  private _clearTimers(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.prodTimer) { clearTimeout(this.prodTimer); this.prodTimer = null; }
    if (this.devNoteTimer) { clearTimeout(this.devNoteTimer); this.devNoteTimer = null; }
  }

  private _getPersonaGreetings(): string[] {
    return PERSONAS[this.deps.getPersona()]?.greetings ?? ["Hey there!"];
  }

  private _rhetoricalVersion(question: string): string {
    const rhetoricals: Record<string, string> = {
      "What's your name?": "I'd ask your name but you can't even talk to me. Let me just look at you instead.",
      "Where are you from?": "I'd ask where you're from but you're the strong silent type. We'll make do.",
      "What do you do for a living?": "I'd ask what you do but you're not exactly forthcoming. I'll use my imagination.",
    };
    return rhetoricals[question] ?? `I'd ask you ${question.toLowerCase()} but I'll just have to guess.`;
  }

  private _generateJokeStream(
    params: {
      context: "answer_roast";
      question?: string;
      userAnswer?: string;
      fillerAlreadySaid?: string;
      jokesAlreadyDelivered?: string[];
      conversationSoFar?: string[];
      knownFacts?: string[];
      maxJokes?: number;
      imageBase64?: string;
    },
    onJoke: (joke: JokeItem) => void,
    onMeta: (meta: {
      relevant: boolean;
      followUp?: string;
      redirect?: string;
      tags?: string[];
      callback?: { text: string; motion: string; intensity: number };
    }) => void,
    onError: () => void,
  ): void {
    fetch("/api/generate-speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...params,
        persona: this.deps.getPersona(),
        burnIntensity: this.deps.getBurnIntensity(),
        contentMode: this.deps.getContentMode(),
      }),
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          onError();
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // retain incomplete last line

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as {
                type: string;
                [key: string]: unknown;
              };
              if (event.type === "joke") {
                onJoke(event as unknown as JokeItem);
              } else if (event.type === "meta") {
                onMeta(
                  event as unknown as {
                    relevant: boolean;
                    followUp?: string;
                    redirect?: string;
                    tags?: string[];
                    callback?: { text: string; motion: string; intensity: number };
                  },
                );
              }
              // audio/tts_inline/audio_done events ignored — TTS handled by queueSpeak
            } catch {
              // malformed SSE line
            }
          }
        }
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          console.error("[brain] generate-speak error:", e);
        }
        onError();
      });
  }

  private async _generateJoke(
    params: {
      context: "greeting" | "vision_opening" | "answer_roast" | "vision_react" | "hopper";
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
    },
    signal?: AbortSignal,
  ): Promise<JokeResponse | null> {
    try {
      const resp = await fetch("/api/generate-joke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...params,
          persona: this.deps.getPersona(),
          burnIntensity: this.deps.getBurnIntensity(),
          contentMode: this.deps.getContentMode(),
          setting: this.deps.getVisionSetting(),
          ambientContext: this.deps.getAmbientContext() ?? undefined,
        }),
        signal,
      });
      if (!resp.ok) return null;
      return (await resp.json()) as JokeResponse;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("[brain] generate-joke error:", e);
      }
      return null;
    }
  }
}
