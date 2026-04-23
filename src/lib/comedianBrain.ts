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

import {
  QUESTION_BANK,
  CONFIRM_TAIL_FILLERS,
  DEFAULT_CONFIRM_ECHO_TEMPLATES,
  ECHO_REJECTION_TEMPLATES,
  REJECT_TEMPLATES,
  type ComedyQuestion,
} from "@/lib/questionBank";
import { transcriptConfidence, CONFIDENCE_THRESHOLDS } from "@/lib/transcriptConfidence";
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
  /** Optional async local culture/vibe line (filled after geolocation). */
  getTownFlavor: () => string | null;
  /** LLM model ID for joke generation (e.g. "gemini-2.5-flash", "gpt-4o"). */
  getRoastModel: () => string;
  /** Current mic input RMS (0-1) — used for background noise gating. */
  getInputAmplitude: () => number;
  /** Multi-turn chat session ID — if set, API routes reuse the session instead of sending the full persona. */
  getSessionId: () => string | null;
  setBrainState: (state: BrainState | null) => void;
  setCurrentQuestion: (q: string | null) => void;
  setUserAnswer: (ans: string) => void;
  logTiming: (entry: string) => void;
  /** Surface a fatal error to the user (quota exhaustion, API key missing, etc.) */
  setError?: (error: string) => void;
  /** Called when session should reveal the puppet (fade in). */
  revealSession?: () => void;
  /** Fire-and-forget: save an in-session critique to feedback storage. */
  saveCritique?: (text: string, context: { persona: PersonaId; lastJokeText?: string }) => void;
  /** Optional: pre-seed for testing */
  initialHopper?: ScoredJoke[];
  initialLedger?: LedgerEntry[];
  /** Pre-fetched greeting result — if set, enterGreeting() skips generation. */
  prefetchedGreeting?: Promise<JokeResponse | null>;
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

function lastWordToken(text: string): string {
  const match = text.match(/([A-Za-z0-9]+)[^A-Za-z0-9]*$/);
  return match?.[1] ?? "";
}

function normalizeForConfirm(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.;:!?-]+/, "")
    .replace(/[,.;:!?-]+$/, "")
    .trim();
}

function shouldStartSpeculative(answerBuffer: string): boolean {
  const trimmed = answerBuffer.trim();
  const words = wordCount(trimmed);
  if (words >= 2) return true;
  if (words === 1) {
    // Avoid speculative calls on very short partial chunks ("Ty", "No", "Uh").
    // This reduces false starts before STT finishes the first word.
    const token = trimmed.split(/\s+/)[0] ?? "";
    return token.length >= 4;
  }
  return false;
}

function normalizeAnswerToken(text: string): string {
  return text.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").trim();
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

  // Previous buffer ends with a letter and chunk starts with lowercase letter.
  // Only join when at least one side is very short (syllable-level continuation),
  // e.g. "Ye" + "s" -> "Yes". For normal words ("a" + "dentist"), add a space.
  if (/[a-zA-Z]$/.test(lastChar) && /^[a-z]/.test(firstChar)) {
    const prevToken = lastWordToken(buffer);
    const nextToken = chunk.trimStart().match(/^[a-z]+/)?.[0] ?? "";
    if (prevToken.length <= 2 || nextToken.length <= 2) return buffer + chunk;
  }

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
  /** True once Gemini Live sent inputTranscription with finished=true for this answer turn. */
  private sttHadFinalSegment = false;
  private earlyListenActivated = false; // true once question TTS is nearly done — gate for early answer capture
  private fillerFiredForAnswer = false; // prevent double filler on late-transcription re-entry
  /** Incremented each time enterGenerating fires — stale stream callbacks check this to avoid double delivery. */
  private deliveryGeneration = 0;
  private prodCount = 0;
  private consecutiveSilentQuestions = 0;
  private visionOnlyMode = false;
  private bankQuestionsInARow = 0; // after 1-2 bank questions, interleave a contextual/vision question
  private started = false;
  private lastDeliveredJokeText = "";

  // Vision state
  private previousObservations: string[] = [];
  private transitionCount = 0;
  /** Queued vision interrupt — consumed at the next natural transition point. */
  private pendingVisionInterrupt: { changes: string[]; current: string[]; previous: string[] } | null = null;

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
  private vadAvailable = true;

  // Last delivered joke motion — used to match question inflection
  private lastJokeMotion: import("@/lib/motionStates").MotionState = "emphasis";
  private lastJokeIntensity = 0.75;

  // Confirmation state
  private pendingConfirmAnswer = "";
  private confirmBuffer = "";
  private confirmAttempts = 0;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  // Greeting state
  private visionReadyForGreeting = false;
  private greetingTtsDrained = false;
  private greetingSpeechQueued = false; // true once greeting generation resolves and speech is queued
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
    this.earlyListenActivated = true;
    this.deps.logTiming("brain: early listen activated");
  }

  setMicAvailable(available: boolean): void {
    this.micAvailable = available;
  }

  setCameraAvailable(available: boolean): void {
    this.cameraAvailable = available;
  }

  setVadAvailable(available: boolean): void {
    this.vadAvailable = available;
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
    // During confirmation: VAD speech-end completes the yes/no response
    if (this.state === "confirm_answer") {
      const response = this.confirmBuffer.trim();
      if (!response) return; // no transcript yet
      this.deps.logTiming(`brain: VAD speech-end in confirm → "${response}"`);
      this._clearConfirmTimer();
      this._processConfirmResponse();
      return;
    }

    if (this.state !== "wait_answer" && this.state !== "pre_generate") return;
    const answer = this.answerBuffer.trim();
    if (!answer) return; // no transcript yet — let the silence timer handle it

    // Silero often fires on a mid-sentence breath before Gemini marks the segment final.
    // Completing here queues the generating filler and cuts the user off. For multi-word
    // answers, wait for authoritative STT (`finished`) or the silence fallback timer.
    if (
      wordCount(answer) >= 3 &&
      !this.sttHadFinalSegment
    ) {
      this.deps.logTiming(
        `brain: VAD speech-end deferred (no final STT yet) — "${answer.slice(0, 48)}"`,
      );
      this._clearTimers();
      this._startAnswerSilenceTimer();
      return;
    }

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

    // Confirmation state: accumulate into confirmBuffer for yes/no classification
    if (this.state === "confirm_answer") {
      this._clearConfirmTimer();
      if (finished && text.trim()) {
        this.confirmBuffer = text;
      } else {
        this.confirmBuffer = smartJoin(this.confirmBuffer, text);
      }
      this.deps.logTiming(`brain: confirm heard "${text}" → buffer "${this.confirmBuffer}"`);
      if (finished) {
        this._processConfirmResponse();
      } else {
        this._startConfirmSilenceTimer();
      }
      return;
    }

    // Late transcription during generation — STT tokens still arriving after silence timer fired.
    // Only restart if we haven't begun delivering yet. Once delivery starts, the answer is committed.
    if (this.state === "generating") {
      const oldAnswer = this.answerBuffer.trim();
      this._accumulateAnswer(text, finished);
      const newAnswer = this.answerBuffer.trim();
      const appended = newAnswer.toLowerCase().startsWith(oldAnswer.toLowerCase())
        ? newAnswer.slice(oldAnswer.length).trim()
        : "";

      // Late "yeah that's right" tails after a confirm prompt should not mutate
      // the committed answer and trigger another confirm loop.
      if (appended && ComedianBrain._isAffirmationTail(appended)) {
        this.deps.logTiming(`brain: late affirmation during generating — "${appended}" → no restart`);
        this.answerBuffer = oldAnswer;
        this.deps.setUserAnswer(this.answerBuffer);
        return;
      }

      // Explicit correction ("no, I said ...") should force a restart even if
      // similarity heuristics say it's "close".
      if (
        ComedianBrain._hasCorrectionCue(text) ||
        (appended && ComedianBrain._hasCorrectionCue(appended))
      ) {
        this._clearTimers();
        this.deps.cancelSpeech();
        this.deps.logTiming(`brain: correction cue during generating — "${text}" (restarting)`);
        this._transition("pre_generate");
        this._cancelSpeculative();
        this._startLateSilenceTimer();
        return;
      }

      // If the buffer didn't materially change (just whitespace/punctuation), don't bounce.
      if (isSimilarAnswer(oldAnswer, newAnswer)) {
        this.deps.logTiming(`brain: late transcription during generating (similar) — "${text}" → no restart`);
        return;
      }
      this._clearTimers();
      this.deps.cancelSpeech();
      this.deps.logTiming(`brain: late transcription during generating — "${text}" → buffer now "${newAnswer}" (restarting)`);
      this._transition("pre_generate");
      this._cancelSpeculative();
      this._startLateSilenceTimer();
      return;
    }

    // Passive reactions while puppet is delivering
    if (this.state === "delivering") {
      this._handleReactionText(text);
      return;
    }

    // Background noise gate: log when amplitude is low but DON'T filter.
    // The old gate silently dropped valid speech because Gemini's transcription
    // arrives after the user stops speaking — by then amplitude has dropped.
    // Gemini's own STT confidence is a better noise filter.
    if (COMEDIAN_CONFIG.inputAmplitudeMin > 0) {
      const amp = this.deps.getInputAmplitude();
      if (amp > 0 && amp < COMEDIAN_CONFIG.inputAmplitudeMin) {
        this.deps.logTiming(`brain: low amplitude ${amp.toFixed(3)} (threshold ${COMEDIAN_CONFIG.inputAmplitudeMin}) — accepting anyway`);
      }
    }

    // User speaks during question TTS — buffer it so it's not lost when we enter wait_answer.
    // Only capture after early listen activates (question nearly done) to avoid picking up
    // background noise (e.g. kids talking) while the question is still playing.
    if (this.state === "ask_question") {
      if (this.earlyListenActivated) {
        this._accumulateAnswer(text, finished);
        this.deps.logTiming(`brain: early answer during ask_question — "${text}"`);
      }
      return;
    }

    if (this.state === "wait_answer" || this.state === "pre_generate") {
      this._clearTimers();
      this._accumulateAnswer(text, finished);
      if (finished) this.sttHadFinalSegment = true;
      this.deps.logTiming(`brain: heard "${text}" → buffer now "${this.answerBuffer}" (${wordCount(this.answerBuffer)}w)`);

      // Start speculative generation once we have enough words
      if (
        !COMEDIAN_CONFIG.skipPreGeneration &&
        this.state === "wait_answer" &&
        wordCount(this.answerBuffer) >= COMEDIAN_CONFIG.speculativeMinWords &&
        shouldStartSpeculative(this.answerBuffer)
      ) {
        this._transition("pre_generate");
        this._startSpeculative();
      }

      // Transcript-based early endpointing: complete immediately when the final transcript
      // looks like a complete thought OR a viable short answer (name/yes-no/number).
      if (
        finished &&
        (
          (wordCount(this.answerBuffer) >= 3 && ComedianBrain._looksComplete(this.answerBuffer)) ||
          this._isViableAnswer(this.answerBuffer)
        )
      ) {
        this.deps.logTiming(`brain: early endpoint — transcript looks complete "${this.answerBuffer.slice(-30)}"`);
        this._clearTimers();
        this._onAnswerComplete();
        return;
      }

      this._startAnswerSilenceTimer();
    }
  }

  /** Heuristic: does this transcript look like a complete thought? */
  private static _looksComplete(text: string): boolean {
    const trimmed = text.trim();
    // Sentence-ending punctuation
    if (/[.?!]\s*$/.test(trimmed)) return true;
    // Common phrase terminals
    if (/\b(I guess|you know|I dunno|that's it|yeah|nope|no|yes)\s*$/i.test(trimmed)) return true;
    return false;
  }

  /** Heuristic: is this a plausible complete answer for the current question? */
  private _isViableAnswer(answer: string): boolean {
    const trimmed = answer.trim();
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 3) return true;

    const normalized = normalizeAnswerToken(trimmed.toLowerCase());
    const qId = this.currentQuestion?.id ?? "";

    if (qId === "name") {
      // Single-word names are common; avoid accepting one-letter fragments.
      return normalized.length >= 2;
    }
    if (qId === "age") {
      return /\b\d{1,3}\b/.test(trimmed);
    }
    if (qId === "single") {
      return /^(yes|yeah|yep|yup|no|nah|nope|single|married|divorced|taken|it's complicated)\b/i.test(trimmed);
    }
    // Generic short-but-valid responses ("dentist", "Seattle", "teacher")
    return words.length >= 2 || normalized.length >= 4;
  }

  /** Short confirmation chatter that often trails a just-confirmed answer. */
  private static _isAffirmationTail(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return false;
    return /^(,?\s*)?(yeah|yes|yep|yup|right|correct|exactly|that's right|that is right|uh huh|mhm|mm-hm)\b/.test(t);
  }

  /** Explicit correction cues that should override similarity checks. */
  private static _hasCorrectionCue(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return false;
    return /^(no|nah|nope|wrong)\b/.test(t) || /\b(i said|that's not|that is not|not that)\b/.test(t);
  }

  /** Normalize for substring match between STT and recent puppet lines. */
  private static _normalizeForEchoMatch(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * STT often returns the puppet's roast punchline (e.g. "you poor bastard") instead of the user's words.
   * If the transcript is a contiguous substring of a joke we just told, reject — don't confirm or roast it as fact.
   */
  private _answerEchoesRecentRoast(answer: string): boolean {
    const a = ComedianBrain._normalizeForEchoMatch(answer);
    if (a.length < 5) return false;
    if (wordCount(answer) > 10) return false;

    const sources: string[] = [];
    if (this.lastDeliveredJokeText) sources.push(this.lastDeliveredJokeText);
    for (const e of this.ledger) {
      if (e.type === "joke") sources.push(e.text);
    }

    const dedup: string[] = [];
    const seen = new Set<string>();
    for (const t of sources) {
      const key = t.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(t);
    }

    for (const raw of dedup.slice(-5)) {
      const src = ComedianBrain._normalizeForEchoMatch(raw);
      if (src.length < 12) continue;
      if (src.includes(a)) return true;
    }

    return false;
  }

  /** Called when vision analysis completes (even with empty observations) */
  onVisionUpdate(observations: string[]): void {
    // Greeting fires generation immediately — no need to wait for vision
    if (this.state === "greeting") return;

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

    // Proactive vision interrupt: if something interesting changes during delivering/wait_answer/ask_question,
    // flag it so the next transition inserts a vision react instead of the normal next step.
    if (
      this.previousObservations.length > 0 &&
      (this.state === "delivering" || this.state === "wait_answer" || this.state === "ask_question")
    ) {
      const { isInteresting, changes } = diffObservations(this.previousObservations, observations);
      if (isInteresting && changes.length > 0) {
        this.pendingVisionInterrupt = { changes, current: observations, previous: [...this.previousObservations] };
        this.previousObservations = [...observations];
        this.deps.logTiming(`brain: vision interrupt queued (${changes.length} changes) — will fire at next transition`);
        // Don't return — still feed hopper below
      }
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
      case "confirm_answer":
        // Confirm prompt finished playing — start listening for yes/no
        this._startConfirmListenTimer();
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
    this.greetingSpeechQueued = false;
    this.visionReadyForGreeting = true;

    this.deps.setMotion("thinking", 0.6);

    // Use prefetched greeting if available (fired during Gemini Live connect to save time),
    // otherwise generate fresh.
    if (this.deps.prefetchedGreeting) {
      this.visionJokePrefetch = this.deps.prefetchedGreeting;
      this.deps.logTiming("brain: using prefetched greeting");
    } else {
      const observations = this.deps.getObservations();
      const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;
      this.visionJokePrefetch = this._generateJoke({
        context: "greeting",
        model: "gemini-2.5-flash", // greeting always uses Gemini — fastest + best at vision
        observations,
        imageBase64: frame,
      });
      this.deps.logTiming("brain: greeting generation fired (no prefetch)");
    }

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
      this.greetingSpeechQueued = true;
      // If drain already fired while we were generating, advance now
      this._maybeAdvanceFromGreeting();
    });
  }

  private _maybeAdvanceFromGreeting(): void {
    // Need both: generation resolved + TTS played through
    if (this.greetingSpeechQueued && this.greetingTtsDrained) {
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
    this.earlyListenActivated = false;
    this.prodCount = 0;
    this.confirmAttempts = 0;
    this.deps.setUserAnswer("");

    // Determine which question to ask
    let question: ComedyQuestion | null = null;
    let shouldListenImmediately = false;

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
          "I'm waiting. The audience is waiting.",
          "Hello? Anyone home?",
        ],
      };
      this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
      this.deps.queueSpeak(followUpText, this.lastJokeMotion, this.lastJokeIntensity);
    } else if (sameQuestion && this.currentQuestion) {
      // Re-ask same question (after redirect)
      this.preQueuedQuestion = null;
      this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);
      this.deps.queueSpeak(this._pickQuestionText(this.currentQuestion), this.lastJokeMotion, this.lastJokeIntensity);
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
        if (this.deps.isQueueEmpty()) {
          // Pre-queued question already drained. Don't re-queue (causes audible duplicates);
          // move directly into listening since the question was already spoken.
          this.deps.logTiming("brain: pre-queued question already drained — entering wait_answer");
          shouldListenImmediately = true;
        } else {
          // TTS is still in the chain — gapless
          this.deps.logTiming("brain: using pre-queued question (zero wait)");
        }
      } else {
        // Rephrase didn't finish in time — fall back to original text immediately
        this.deps.logTiming("brain: rephrase not ready — using original question text");
        this._queueQuestionWithBridge(this._pickQuestionText(question));
      }
    } else {
      // Clear follow-up state — new topic
      this.pendingFollowUp = null;
      this.followUpCount = 0;

      // Interleave bank questions with contextual/vision questions.
      // After every bank question, generate a contextual one (what do you do in that office?).
      // This keeps the show feeling reactive rather than like a questionnaire.
      const bankAvailable = this._nextValidQuestion();
      const shouldUseContextual = this.bankQuestionsInARow >= 1 && this.cameraAvailable;

      if (bankAvailable && !shouldUseContextual) {
        // Use bank question
        question = bankAvailable;
        this.askedQuestionIds.add(question.id);
        this.currentQuestion = question;
        this.bankQuestionsInARow++;
        this._queueQuestionWithBridge(this._pickQuestionText(this.currentQuestion));
      } else {
        // Generate a contextual question based on what we see + know
        this.bankQuestionsInARow = 0;
        this._generateContextualQuestion();
        return; // async — will set currentQuestion when it resolves
      }
    }

    if (!this.currentQuestion) return;

    this.deps.setCurrentQuestion(this.currentQuestion.question);
    this._addLedger("question", this.currentQuestion.question, []);
    if (shouldListenImmediately) {
      this.enterWaitAnswer();
    }
  }

  private enterWaitAnswer(): void {
    this._transition("wait_answer");
    this.deps.setMotion("listening", 0.5);
    this.fillerFiredForAnswer = false;
    this.sttHadFinalSegment = false;

    // If user already spoke during ask_question, start silence timer (not prod timer)
    if (this.answerBuffer.trim()) {
      this.deps.logTiming(`brain: wait_answer with pre-buffered answer — "${this.answerBuffer}"`);
      if (
        !COMEDIAN_CONFIG.skipPreGeneration &&
        wordCount(this.answerBuffer) >= COMEDIAN_CONFIG.speculativeMinWords &&
        shouldStartSpeculative(this.answerBuffer)
      ) {
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
    const silenceMs = this.vadAvailable
      ? COMEDIAN_CONFIG.answerSilenceMs
      : this._isViableAnswer(this.answerBuffer)
        ? COMEDIAN_CONFIG.answerSilenceMs
        : Math.max(COMEDIAN_CONFIG.answerSilenceMs, 900);
    this.silenceTimer = setTimeout(() => {
      if (this.state === "wait_answer" || this.state === "pre_generate") {
        this._onAnswerComplete();
      }
    }, silenceMs);
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
    if (COMEDIAN_CONFIG.skipScriptedLines) {
      // No canned prod — just count and eventually skip the question
      this._transition("prodding");
      this.prodCount++;
      if (this.prodCount >= COMEDIAN_CONFIG.maxProds) {
        this.consecutiveSilentQuestions++;
        if (this.consecutiveSilentQuestions >= COMEDIAN_CONFIG.silentQuestionsBeforeVisionMode) {
          this.visionOnlyMode = true;
        }
        this.enterCheckVision();
      } else {
        this._startProdTimer();
      }
      return;
    }
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

    // STT often captures the puppet's last roast line (e.g. "you poor bastard" → user "Poor bastard.")
    // Never treat that as their answer — reject and re-ask like garbage transcript.
    if (this._answerEchoesRecentRoast(answer)) {
      this.deps.logTiming(`brain: reject echo of recent roast — "${answer}"`);
      this.answerBuffer = "";
      this.deps.setUserAnswer("");
      const line =
        ECHO_REJECTION_TEMPLATES[Math.floor(Math.random() * ECHO_REJECTION_TEMPLATES.length)];
      this.deps.queueSpeak(line, "conspiratorial", 0.55);
      this._cancelSpeculative();
      this._transition("ask_question");
      return;
    }

    // Confidence gate — reject garbage, confirm dubious, pass clean answers through
    // Skip when scripted lines are disabled (no canned confirm/reject templates)
    if (COMEDIAN_CONFIG.confirmationEnabled && !COMEDIAN_CONFIG.skipScriptedLines) {
      const qId = this.currentQuestion?.id ?? "";
      // Name confirmations are useful for short transcripts ("Mike"/"Mark"),
      // but long multi-word replies are usually intentional bits, not STT errors.
      if (qId === "name" && wordCount(answer) >= 3) {
        this.deps.logTiming(`brain: skip name confirmation for long answer — "${answer}"`);
        this.enterGenerating(answer);
        return;
      }
      const confidence = transcriptConfidence(answer, qId);
      const threshold = this.currentQuestion?.confirmThreshold ?? CONFIDENCE_THRESHOLDS.defaultConfirm;

      if (confidence < CONFIDENCE_THRESHOLDS.reject) {
        // Garbage — reject outright, ask again.
        // Use ask_question so onTtsQueueDrained → enterWaitAnswer() starts prod timers.
        this.deps.logTiming(`brain: reject transcript (confidence=${confidence.toFixed(2)}) — "${answer}"`);
        this.answerBuffer = "";
        this.deps.setUserAnswer("");
        const line = REJECT_TEMPLATES[Math.floor(Math.random() * REJECT_TEMPLATES.length)];
        this.deps.queueSpeak(line, "conspiratorial", 0.5);
        this._cancelSpeculative();
        this._transition("ask_question");
        return;
      }

      if (confidence < threshold) {
        // Low confidence — confirm before proceeding
        this.deps.logTiming(`brain: confirm transcript (confidence=${confidence.toFixed(2)}, threshold=${threshold}) — "${answer}"`);
        this._cancelSpeculative();
        this.enterConfirmAnswer(answer);
        return;
      }
    }

    this.enterGenerating(answer);
  }

  // ─── Answer confirmation ─────────────────────────────────────────────────────

  private enterConfirmAnswer(answer: string): void {
    this._transition("confirm_answer");
    const normalized = normalizeForConfirm(answer) || answer.trim();
    this.pendingConfirmAnswer = normalized;
    this.confirmBuffer = "";
    this.confirmAttempts++; // 1 = first attempt; at maxConfirmAttempts, proceeds without re-confirming
    this.deps.setMotion("conspiratorial", 0.6);

    // Echo what we think we heard, then a short absurdist “mis-hear” filler — no “did you say?”
    // Silence after both play (confirmTimeoutMs) = implicit yes and we roast the echoed answer.
    const templates = this.currentQuestion?.confirmTemplates ?? DEFAULT_CONFIRM_ECHO_TEMPLATES;
    const echoTemplate = templates[Math.floor(Math.random() * templates.length)];
    const echoAnswer = normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
    const echoLine = echoTemplate.replaceAll("{answer}", echoAnswer);
    const tail =
      CONFIRM_TAIL_FILLERS[Math.floor(Math.random() * CONFIRM_TAIL_FILLERS.length)];

    this.deps.queueSpeak(echoLine, "conspiratorial", 0.65);
    this.deps.queueSpeak(tail, "thinking", 0.55);
    this.deps.logTiming(
      `brain: confirm echo+t — "${echoLine.slice(0, 96)}" · "${tail}" (${this.confirmAttempts})`,
    );
  }

  /** Start listening timer after confirm prompt finishes playing. */
  private _startConfirmListenTimer(): void {
    this._clearConfirmTimer();
    // Silence after prompt = implicit yes (user didn't object)
    this.confirmTimer = setTimeout(() => {
      if (this.state !== "confirm_answer") return;
      this.deps.logTiming(`brain: confirm timeout (${COMEDIAN_CONFIG.confirmTimeoutMs}ms) — implicit yes for "${this.pendingConfirmAnswer}"`);
      this._confirmAccepted();
    }, COMEDIAN_CONFIG.confirmTimeoutMs);
  }

  /** Start short silence timer after user starts responding to confirmation. */
  private _startConfirmSilenceTimer(): void {
    this._clearConfirmTimer();
    this.confirmTimer = setTimeout(() => {
      if (this.state !== "confirm_answer") return;
      this._processConfirmResponse();
    }, COMEDIAN_CONFIG.confirmSilenceMs);
  }

  private _clearConfirmTimer(): void {
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
  }

  private _confirmAccepted(): void {
    this._clearConfirmTimer();
    this.confirmAttempts = 0;
    this.answerBuffer = this.pendingConfirmAnswer;
    this.deps.setUserAnswer(this.answerBuffer);
    this.deps.logTiming(`brain: confirmed — "${this.pendingConfirmAnswer}"`);
    this.enterGenerating(this.pendingConfirmAnswer);
  }

  private _processConfirmResponse(): void {
    const response = normalizeForConfirm(this.confirmBuffer);
    if (!response) {
      // No response heard — treat as implicit yes
      this._confirmAccepted();
      return;
    }

    const classification = ComedianBrain._classifyConfirmResponse(response);
    this.deps.logTiming(`brain: confirm response "${response}" → ${classification}`);

    switch (classification) {
      case "affirm":
        this._confirmAccepted();
        break;

      case "deny_correction": {
        // Extract corrected answer — strip leading negation
        const corrected = response.replace(/^(no+|nah|nope|wrong)[,.]?\s*/i, "").trim();
        // Strip common filler phrases before the actual answer
        const cleaned = normalizeForConfirm(
          corrected.replace(/^(it's|its|it is|i said|my name is|i'm|im|actually)\s+/i, "").trim()
        );
        if (!cleaned) {
          // They said "no" with filler but no actual correction — treat as bare deny
          this._confirmDenied();
          break;
        }
        if (this.confirmAttempts >= COMEDIAN_CONFIG.maxConfirmAttempts) {
          // Max attempts — proceed with the correction without re-confirming
          this.deps.logTiming(`brain: max confirm attempts — proceeding with "${cleaned}"`);
          this.pendingConfirmAnswer = cleaned;
          this._confirmAccepted();
        } else {
          // Re-confirm with the corrected answer
          this.enterConfirmAnswer(cleaned);
        }
        break;
      }

      case "deny_bare":
        this._confirmDenied();
        break;

      case "restate":
        // Streaming STT often arrives in fragments (", I love my" -> "name.").
        // If this still looks partial, wait for more chunks instead of re-confirming.
        if (!/[.?!]\s*$/.test(this.confirmBuffer.trim()) && wordCount(response) < 4) {
          this.deps.logTiming(`brain: confirm response looks partial — waiting for more ("${response}")`);
          this._startConfirmSilenceTimer();
          break;
        }
        // User restated their answer without saying no — treat as a new answer
        if (this.confirmAttempts >= COMEDIAN_CONFIG.maxConfirmAttempts) {
          this.deps.logTiming(`brain: max confirm attempts — proceeding with restatement "${response}"`);
          this.pendingConfirmAnswer = response;
          this._confirmAccepted();
        } else {
          this.enterConfirmAnswer(response);
        }
        break;
    }
  }

  private _confirmDenied(): void {
    this._clearConfirmTimer();
    this.confirmAttempts = 0;
    this.answerBuffer = "";
    this.deps.setUserAnswer("");
    this.deps.queueSpeak("One more time?", "conspiratorial", 0.5);
    // Use ask_question so onTtsQueueDrained → enterWaitAnswer() starts prod timers
    this._transition("ask_question");
    this.deps.logTiming("brain: confirm denied — back to ask_question (will enter wait_answer on TTS drain)");
  }

  private static readonly AFFIRM_RE = /^(yes|yeah|yep|yup|correct|right|that's right|uh-huh|mhm|mm-?hm|sure|exactly)/i;
  private static readonly DENY_RE = /^(nope|nah|no+|wrong)/i;

  static _classifyConfirmResponse(text: string): "affirm" | "deny_correction" | "deny_bare" | "restate" {
    const trimmed = text.trim();
    if (ComedianBrain.AFFIRM_RE.test(trimmed)) return "affirm";
    if (ComedianBrain.DENY_RE.test(trimmed)) {
      // Check if there are additional words after the negation (= correction)
      const afterNegation = trimmed.replace(ComedianBrain.DENY_RE, "").replace(/^[,.\s]+/, "").trim();
      return afterNegation.length > 0 ? "deny_correction" : "deny_bare";
    }
    return "restate";
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
    if (!COMEDIAN_CONFIG.skipFiller && !this.fillerFiredForAnswer) {
      this.fillerFiredForAnswer = true;
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
      },
      // onJoke — fires immediately as each joke streams in
      (joke) => {
        if (this.deliveryGeneration !== gen) return; // stale stream — ignore
        if (this.state !== "generating" && this.state !== "delivering") return;
        if (this.state === "generating") {
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
    if (prefetch?.done) {
      this.pipelinePrefetch = null;
      this.pipelinePrefetchAbort = null;

      if (prefetch.jokes.length > 0) {
        // Prefetch ready but not yet queued — queue now
        this.deps.logTiming("brain: using prefetched pipeline joke (zero wait)");
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
      } else {
        // Jokes were already eagerly queued from the prefetch callback — TTS was in the chain.
        // Since we're inside _onDeliveringDrained (called from drain poll), the eagerly-queued
        // joke has already played — both jokes drained as one batch. Advance immediately.
        this.deps.logTiming("brain: pipeline joke already eagerly queued — advancing");
        this._onDeliveringDrained();
        return;
      }
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

  // Short bridge phrases that connect a joke to the next question — keeps the energy flowing.
  // Spoken as a separate TTS call so ElevenLabs previous_text carries the joke's vocal tone.
  private static readonly QUESTION_BRIDGES = [
    "Okay.", "Alright.", "Anyway.", "Moving on.", "But seriously.",
    "So.", "Now.", "Let me ask you this.", "Okay okay.",
  ];

  /** Pick the question text variant — uses vulgarQuestions when contentMode is "vulgar". */
  private _pickQuestionText(q: ComedyQuestion): string {
    if (this.deps.getContentMode() === "vulgar" && q.vulgarQuestions?.length) {
      return q.vulgarQuestions[Math.floor(Math.random() * q.vulgarQuestions.length)];
    }
    return q.question;
  }

  /** Queue question with LLM rephrase for natural variation.
   *  Races rephrase vs ~2.8s timeout — falls back to original + bridge if slow. */
  private _queueQuestionWithBridge(questionText: string): void {
    this.deps.setMotion(this.lastJokeMotion, this.lastJokeIntensity);

    // Get the last joke text for rephrase context
    const lastJoke = this.ledger
      .filter((e) => e.type === "joke")
      .at(-1)?.text ?? "";

    // Race: rephrase vs timeout
    const rephrasePromise = fetch("/api/rephrase-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: questionText,
        model: this.deps.getRoastModel(),
        persona: this.deps.getPersona(),
        burnIntensity: this.deps.getBurnIntensity(),
        knownFacts: this._getThrowbackContext(),
        previousLine: lastJoke,
      }),
    })
      .then((r) => r.json())
      .then((d: { rephrased?: string }) => d.rephrased?.trim() || null)
      .catch(() => null);

    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2800));

    Promise.race([rephrasePromise, timeoutPromise]).then((rephrased) => {
      // Guard: only queue if we're in ask_question (normal path) or the pre-queue is
      // still pending (pipeline path — brain may be in delivering/generating/check_vision).
      // If preQueuedQuestion was cleared (consumed or cancelled), this callback is stale.
      if (this.state !== "ask_question" && !this.preQueuedQuestion) return;
      if (rephrased) {
        this.deps.queueSpeak(rephrased, "emphasis", 0.6);
        this.deps.logTiming(`brain: rephrased question — "${rephrased.slice(0, 60)}"`);
      } else if (COMEDIAN_CONFIG.skipScriptedLines) {
        this.deps.queueSpeak(questionText, "emphasis", 0.6);
        this.deps.logTiming("brain: rephrase timed out — using original (no bridge)");
      } else {
        const bridge = ComedianBrain.QUESTION_BRIDGES[Math.floor(Math.random() * ComedianBrain.QUESTION_BRIDGES.length)];
        this.deps.queueSpeak(`${bridge} ${questionText}`, "emphasis", 0.6);
        this.deps.logTiming("brain: rephrase timed out — using original");
      }
    });
  }

  /** Generate a contextual question via LLM based on what we see + know. */
  private _generateContextualQuestion(): void {
    this.deps.setMotion("thinking", 0.6);
    this.deps.logTiming("brain: generating contextual question");

    const observations = this.deps.getObservations();
    const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;

    fetch("/api/generate-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.deps.getRoastModel(),
        persona: this.deps.getPersona(),
        observations,
        setting: this.deps.getVisionSetting(),
        knownFacts: this._getThrowbackContext(),
        conversationSoFar: this._getLedgerContext(),
        imageBase64: frame,
      }),
    })
      .then((r) => r.json())
      .then((data: { question: string; jokeContext: string }) => {
        if (this.state !== "ask_question") return; // stale
        const questionText = data.question;
        this.currentQuestion = {
          id: `generated_${Date.now()}`,
          question: questionText,
          jokeContext: data.jokeContext,
          prodLines: [
            "Come on, I'm waiting.",
            "I asked you a question.",
          ],
        };
        this.deps.setCurrentQuestion(questionText);
        this._addLedger("question", questionText, []);
        this._queueQuestionWithBridge(questionText);
        this.deps.logTiming(`brain: contextual question — "${questionText}"`);
      })
      .catch(() => {
        if (this.state !== "ask_question") return;
        // Fallback — ask where they are
        const fallback = "So where are you right now? What am I looking at back there?";
        this.currentQuestion = {
          id: "generated_fallback",
          question: fallback,
          jokeContext: "Location and environment roast.",
          prodLines: ["Hello? Where are you?", "I'm talking to you."],
        };
        this.deps.setCurrentQuestion(fallback);
        this._addLedger("question", fallback, []);
        this._queueQuestionWithBridge(fallback);
      });
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
    // If this is the last pipeline joke, do not pre-queue the next question yet.
    // We still need to pass through check_vision/vision_react first; speaking a question
    // early causes users to answer while the brain isn't listening yet.
    if (this.pipelineJokesDelivered + 1 >= maxJokes) {
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
      },
      abort.signal,
    ).then((response) => {
      if (abort.signal.aborted || !response) return;
      prefetch.jokes = response.jokes;
      prefetch.meta = { followUp: response.followUp, tags: response.tags };
      prefetch.done = true;
      this.deps.logTiming(`brain: pipeline prefetch ready (${response.jokes.length} jokes)`);

      // Queue jokes immediately so TTS prefetch starts while current joke is still playing.
      // When _pipelineNextJoke fires on drain, it will find the prefetch consumed and
      // the TTS already in the chain — zero wait.
      if (this.state === "delivering" && prefetch.jokes.length > 0) {
        for (const joke of prefetch.jokes) {
          this.deps.queueSpeak(joke.text, joke.motion as import("@/lib/motionStates").MotionState, joke.intensity);
          this.pipelinePreviousJokes.push(joke.text);
          this._addLedger("joke", joke.text, []);
          this.lastJokeMotion = joke.motion as import("@/lib/motionStates").MotionState;
          this.lastJokeIntensity = joke.intensity;
        }
        if (prefetch.meta?.followUp) this.pendingFollowUp = prefetch.meta.followUp;
        if (prefetch.meta?.tags?.length) this._addLedger("answer", answer, prefetch.meta.tags);
        // Mark as consumed so _pipelineNextJoke skips straight to _onDeliveringDrained
        prefetch.jokes = [];
        this.deps.logTiming("brain: pipeline joke queued eagerly (TTS prefetch started)");
      }
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

    // Check for proactively queued vision interrupt first
    if (this.pendingVisionInterrupt) {
      const { changes, current, previous } = this.pendingVisionInterrupt;
      this.pendingVisionInterrupt = null;
      this.deps.logTiming("brain: consuming queued vision interrupt");
      this.enterVisionReact(changes, current, previous);
      return;
    }

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

  private static CRITIQUE_RE = /not\s+funny|wasn'?t\s+funny|isn'?t\s+funny|too\s+(mean|harsh|far|rude)|stop\s+(that|it)|offensive|inappropriate|don'?t\s+(joke|talk)\s+about|that\s+(hurt|sucked|was\s+bad)/i;

  private _handleReactionText(text: string): void {
    const lower = text.toLowerCase();
    const isLaughter = /ha|hehe|lol|haha/.test(lower);
    const isCritique = ComedianBrain.CRITIQUE_RE.test(lower);

    if (isLaughter) {
      this._addLedger("reaction", text, ["reaction:laughter"]);
      this._fireHopperGeneration("riff_on_reaction");
    } else if (isCritique) {
      this._addLedger("reaction", text, ["reaction:critique"]);
      this.deps.logTiming(`brain: critique detected — "${text}"`);
      this.deps.saveCritique?.(text, {
        persona: this.deps.getPersona(),
        lastJokeText: this.lastDeliveredJokeText || undefined,
      });
    } else if (text.trim().split(/\s+/).length <= 5) {
      this._addLedger("reaction", text, ["reaction:verbal"]);
    }
  }

  // ─── Ledger ───────────────────────────────────────────────────────────────────

  private _addLedger(
    type: LedgerEntry["type"],
    text: string,
    tags: string[],
  ): void {
    if (type === "joke") this.lastDeliveredJokeText = text;
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
      // Don't include region/county — just city name
    }
    return [...new Set(facts)]; // dedupe
  }

  /**
   * When prior jokes already echoed geo/time/weather, drop the generic AMBIENT boilerplate on the API
   * side and inject a strict instruction instead — stops "Monday afternoon in Woodacre in the drizzle" every line.
   */
  private _ambientAntiRepeatNote(): string | undefined {
    const ac = this.deps.getAmbientContext();
    if (!ac || ac.city === "unknown") return undefined;

    const jokeTexts = this.ledger
      .filter((e) => e.type === "joke")
      .map((e) => e.text.toLowerCase());
    if (jokeTexts.length === 0) return undefined;

    const combined = jokeTexts.join("\n");

    const cityLc = ac.city.trim().toLowerCase();
    const usedCity = cityLc.length >= 2 && combined.includes(cityLc);

    const weekdayLc = new Date().toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const usedWeekday = combined.includes(weekdayLc);

    const todLc = ac.timeOfDay.toLowerCase();
    const todHits = ["morning", "afternoon", "evening", "night"].filter(
      (w) => todLc.includes(w) && combined.includes(w),
    );

    let usedWeather = false;
    if (ac.weather) {
      const w = ac.weather.toLowerCase();
      const stems = ["drizzl", "rain", "rainy", "storm", "snow", "fog", "wind", "cloud", "overcast", "clear"];
      usedWeather = stems.some((stem) => w.includes(stem) && combined.includes(stem));
      const words = w.split(/[\s,]+/).filter((x) => x.length >= 4);
      usedWeather ||= words.some((word) => combined.includes(word.toLowerCase()));
    }

    if (!usedCity && !usedWeekday && todHits.length === 0 && !usedWeather) return undefined;

    const bits: string[] = [];
    if (usedCity) bits.push(`place (“${ac.city}”)`);
    if (usedWeekday) bits.push(`weekday (${weekdayLc})`);
    if (todHits.length > 0) bits.push(`time-of-day (${todHits.join(", ")})`);
    if (usedWeather) bits.push("weather vibe");

    return (
      `AMBIENT DISCIPLINE (mandatory): Earlier [joke] lines already referenced ${bits.join(", ")}. ` +
        `Do NOT repeat the scenic stack (town + weekday + weather/time) as filler. ` +
        `Do NOT reopen with "${weekdayLc} afternoon in ${ac.city}" style setups — they've been burned. ` +
        `Roast the USER'S ANSWER or riff without restating geography unless ONE word is the punchline itself.`
    );
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
    this._clearConfirmTimer();
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
        model: this.deps.getRoastModel(),
        sessionId: this.deps.getSessionId(),
        persona: this.deps.getPersona(),
        burnIntensity: this.deps.getBurnIntensity(),
        contentMode: this.deps.getContentMode(),
        ambientContext: this.deps.getAmbientContext() ?? undefined,
        ambientAntiRepeatNote: this._ambientAntiRepeatNote(),
        townFlavor: this.deps.getTownFlavor()?.trim() || undefined,
      }),
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          if (resp.status === 402) {
            const body = await resp.json().catch(() => ({ provider: "unknown" }));
            const provider = (body as { provider?: string }).provider ?? "unknown";
            this.deps.setError?.(`${provider} credits exhausted — add billing or switch models`);
            this.deps.logTiming(`brain: QUOTA ERROR from ${provider}`);
          }
          onError();
          return;
        }

        let metaSeen = false;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handleEvent = (event: { type: string; [key: string]: unknown }): boolean => {
          if (event.type === "joke") {
            onJoke(event as unknown as JokeItem);
          } else if (event.type === "error" && event.error === "quota_exceeded") {
            const provider = (event.provider as string) ?? "unknown";
            this.deps.setError?.(`${provider} credits exhausted — add billing or switch models`);
            this.deps.logTiming(`brain: QUOTA ERROR from ${provider} (stream)`);
            onError();
            return true;
          } else if (event.type === "meta") {
            metaSeen = true;
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
          return false;
        };

        const parseLines = (lines: string[]): boolean => {
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type: string; [key: string]: unknown };
              if (handleEvent(event)) return true;
            } catch {
              // malformed SSE line
            }
          }
          return false;
        };

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          if (parseLines(lines)) return;
        }

        if (buffer.trim() && parseLines(buffer.split("\n"))) return;

        if (!metaSeen) {
          this.deps.logTiming("brain: generate-speak stream ended without meta — synthesizing");
          onMeta({ relevant: true });
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
      /** Override the roast model for this request (e.g. Gemini Flash for vision-reactive jokes). */
      model?: string;
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
          model: this.deps.getRoastModel(),
          ...params,
          sessionId: this.deps.getSessionId(),
          persona: this.deps.getPersona(),
          burnIntensity: this.deps.getBurnIntensity(),
          contentMode: this.deps.getContentMode(),
          setting: this.deps.getVisionSetting(),
          ambientContext: this.deps.getAmbientContext() ?? undefined,
          ambientAntiRepeatNote: this._ambientAntiRepeatNote(),
          townFlavor: this.deps.getTownFlavor()?.trim() || undefined,
        }),
        signal,
      });
      if (!resp.ok) {
        if (resp.status === 402) {
          const body = await resp.json().catch(() => ({ provider: "unknown" }));
          const provider = (body as { provider?: string }).provider ?? "unknown";
          this.deps.setError?.(`${provider} credits exhausted — add billing or switch models`);
          this.deps.logTiming(`brain: QUOTA ERROR from ${provider}`);
        }
        return null;
      }
      return (await resp.json()) as JokeResponse;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("[brain] generate-joke error:", e);
      }
      return null;
    }
  }
}
