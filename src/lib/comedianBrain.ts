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
import type { PersonaId } from "@/lib/personas";
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
  getObservations: () => string[];
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
  private currentQuestion: ComedyQuestion | null = null;
  private answerBuffer = "";
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

  // Availability flags
  private micAvailable = true;
  private cameraAvailable = true;

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

    this.shuffledQuestions = shuffle(QUESTION_BANK);
    this.questionIndex = 0;
    this.ledger = [];
    this.jokeHopper = [];
    this.transitionCount = 0;
    this.consecutiveSilentQuestions = 0;
    this.visionOnlyMode = false;

    // If vision observations are already available (pre-scanned), skip greeting → vision jokes
    const existingObs = this.deps.getObservations();
    if (existingObs.length > 0 && this.cameraAvailable) {
      this.deps.logTiming("brain: observations pre-loaded, skipping greeting → vision_jokes");
      this.previousObservations = [];
      this.enterVisionJokes();
      return;
    }

    this.enterGreeting();
  }

  stop(): void {
    this._clearTimers();
    this._cancelSpeculative();
    this._cancelHopper();
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

  setMicAvailable(available: boolean): void {
    this.micAvailable = available;
  }

  setCameraAvailable(available: boolean): void {
    this.cameraAvailable = available;
  }

  /** Called when Gemini transcribes user speech */
  onInputTranscription(text: string): void {
    if (!text.trim()) return;

    // In prodding state: user spoke → cancel prod, return to wait_answer
    if (this.state === "prodding") {
      this.deps.cancelSpeech();
      this._clearTimers();
      this.answerBuffer = text;
      this.deps.setUserAnswer(text);
      this._transition("wait_answer");
      // Answer already started — use silence timer, not prod timer
      this._startAnswerSilenceTimer();
      return;
    }

    // Passive reactions while puppet is delivering
    if (this.state === "delivering") {
      this._handleReactionText(text);
      return;
    }

    // User speaks during question TTS — buffer it so it's not lost when we enter wait_answer
    if (this.state === "ask_question") {
      this.answerBuffer = smartJoin(this.answerBuffer, text);
      this.deps.setUserAnswer(this.answerBuffer);
      this.deps.logTiming(`brain: early answer during ask_question — "${text}"`);
      return;
    }

    if (this.state === "wait_answer" || this.state === "pre_generate") {
      this._clearTimers(); // reset silence timer
      this.answerBuffer = smartJoin(this.answerBuffer, text);
      this.deps.setUserAnswer(this.answerBuffer);

      // Start speculative generation once we have enough words
      if (
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
    // During greeting, flag that vision is ready regardless of content
    if (this.state === "greeting") {
      this.visionReadyForGreeting = true;
      this._maybeAdvanceFromGreeting();
      return;
    }

    if (observations.length === 0) return;

    // Feed hopper with new vision context
    this._fireHopperGeneration("vision", observations);
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
      case "redirecting":
        // Re-ask the same question
        this.enterAskQuestion(true /* same question */);
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

    // Set 3s vision timeout
    this.greetingVisionTimeout = setTimeout(() => {
      this.visionReadyForGreeting = true;
      this._maybeAdvanceFromGreeting();
    }, COMEDIAN_CONFIG.greetingVisionTimeoutMs);

    // Pick greeting from persona greetings (anti-repeat shuffle)
    const persona = this.deps.getPersona();
    const greetingKey = `comedian-greetings-${persona}`;
    let usedIndices: number[] = [];
    try {
      usedIndices = JSON.parse(sessionStorage.getItem(greetingKey) ?? "[]") as number[];
    } catch { /* ignore */ }

    // Get persona greetings
    const greetings = this._getPersonaGreetings();
    const available = greetings
      .map((_, i) => i)
      .filter((i) => !usedIndices.includes(i));
    const pool = available.length > 0 ? available : greetings.map((_, i) => i);
    const idx = pool[Math.floor(Math.random() * pool.length)];
    const greetingText = greetings[idx];

    // Track used
    const newUsed = available.length > 0 ? [...usedIndices, idx] : [idx];
    try {
      sessionStorage.setItem(greetingKey, JSON.stringify(newUsed));
    } catch { /* ignore */ }

    this.deps.setMotion("energetic", 0.8);
    this.deps.queueSpeak(greetingText, "energetic", 0.8);
    this._addLedger("joke", greetingText, []);

    // Prefetch vision opening jokes while greeting is playing to cut post-greeting latency
    const observations = this.deps.getObservations();
    const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;
    this.visionJokePrefetch = this._generateJoke({
      context: "vision_opening",
      observations,
      imageBase64: frame,
    });

    this.deps.logTiming("brain: greeting queued, vision joke prefetch started");
  }

  private _maybeAdvanceFromGreeting(): void {
    if (this.greetingTtsDrained && this.visionReadyForGreeting) {
      if (this.greetingVisionTimeout) {
        clearTimeout(this.greetingVisionTimeout);
        this.greetingVisionTimeout = null;
      }
      if (this.cameraAvailable) {
        this.enterVisionJokes();
      } else {
        this._transition("ask_question");
        this.enterAskQuestion();
      }
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
      }
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

    if (this.pendingFollowUp && !sameQuestion) {
      // Ask generated follow-up
      const followUpText = this.pendingFollowUp;
      this.pendingFollowUp = null;
      this.currentQuestion = {
        id: "follow_up",
        question: followUpText,
        jokeContext: "Answer-driven follow-up question.",
        prodLines: [
          "Come on, I set that up perfectly.",
          "I'm waiting. The audience is waiting.",
        ],
      };
    } else if (sameQuestion && this.currentQuestion) {
      // Re-ask same question (after redirect)
    } else if (this.visionOnlyMode) {
      // Vision-only: no more questions
      this._transition("check_vision");
      this.enterCheckVision();
      return;
    } else {
      question = this.shuffledQuestions[this.questionIndex % this.shuffledQuestions.length];
      this.questionIndex++;
      this.currentQuestion = question;
    }

    if (!this.currentQuestion) return;

    this.deps.setCurrentQuestion(this.currentQuestion.question);
    this._addLedger("question", this.currentQuestion.question, []);

    const questionText = this.micAvailable
      ? this.currentQuestion.question
      : this._rhetoricalVersion(this.currentQuestion.question);

    this.deps.queueSpeak(questionText, "emphasis", 0.75);
  }

  private enterWaitAnswer(): void {
    this._transition("wait_answer");
    this.deps.setMotion("listening", 0.5);

    // If user already spoke during ask_question, start silence timer (not prod timer)
    if (this.answerBuffer.trim()) {
      this.deps.logTiming(`brain: wait_answer with pre-buffered answer — "${this.answerBuffer}"`);
      if (wordCount(this.answerBuffer) >= COMEDIAN_CONFIG.speculativeMinWords) {
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

  private enterGenerating(answer: string): void {
    this._transition("generating");
    this.deps.setMotion("thinking", 0.7);
    this._addLedger("answer", answer, []);

    const q = this.currentQuestion;
    const conversationSoFar = this._getLedgerContext();

    // Check if speculative result is still usable
    const spec = this.speculativeRequest;
    if (spec && isSimilarAnswer(spec.snapshot, answer)) {
      // Reuse speculative result — but fall back to fresh if it returned empty
      spec.result.then((response) => {
        if (this.state !== "generating") return;
        this._speculativeRequest = null;
        if (response && response.jokes.length > 0) {
          this.enterDelivering(answer, response);
        } else {
          // Speculative returned empty — generate fresh
          this.deps.logTiming("brain: speculative returned empty, generating fresh");
          this._generateAndDeliver(answer, q, conversationSoFar);
        }
      }).catch(() => {
        // Speculative failed — generate fresh
        if (this.state !== "generating") return;
        this._generateAndDeliver(answer, q, conversationSoFar);
      });
      this._cancelSpeculative(); // clear the ref (result promise still resolves)
    } else {
      // Cancel stale speculative, generate fresh
      this._cancelSpeculative();
      this._generateAndDeliver(answer, q, conversationSoFar);
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
  ): void {
    let jokesQueued = 0;
    let metaHandled = false;

    this._generateJokeStream(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: answer,
        conversationSoFar,
        imageBase64: this.cameraAvailable ? this.deps.captureFrame() : undefined,
      },
      // onJoke — fires immediately as each joke streams in
      (joke) => {
        if (this.state !== "generating" && this.state !== "delivering") return;
        if (this.state === "generating") {
          // First joke arrived — transition to delivering now
          this._transition("delivering");
          this.deps.setMotion("energetic", 0.8);
        }
        this.deps.queueSpeak(joke.text, joke.motion as import("@/lib/motionStates").MotionState, joke.intensity);
        this._addLedger("joke", joke.text, []);
        jokesQueued++;
      },
      // onMeta — fires after all jokes stream, with follow-up/redirect/tags/callback
      (meta) => {
        if (this.state !== "generating" && this.state !== "delivering") return;
        metaHandled = true;

        if (!meta.relevant && meta.redirect) {
          // Irrelevant answer — cancel anything queued and redirect
          this.deps.cancelSpeech();
          this._transition("delivering");
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

        // Bonus hopper joke (every other delivery to avoid overuse)
        if (this.transitionCount % 2 === 0) {
          const bonus = this._popHopperJoke(COMEDIAN_CONFIG.hopperMinScoreForBonus);
          if (bonus) {
            this.deps.queueSpeak("Oh wait, one more thing—", "emphasis", 0.7);
            this.deps.queueSpeak(bonus.text, bonus.motion, bonus.intensity);
            this._addLedger("joke", bonus.text, []);
            jokesQueued += 2;
          }
        }

        if (jokesQueued === 0) {
          this.deps.logTiming("brain: stream delivered nothing — advancing");
          this._onDeliveringDrained();
          return;
        }

        this._fireHopperGeneration("answer", undefined, answer);
      },
      // onError — stream failed, fall back to non-streaming
      () => {
        if (metaHandled) return;
        if (this.state !== "generating") return;
        this.deps.logTiming("brain: stream failed, generating fresh");
        this._generateJoke({
          context: "answer_roast",
          question: q?.question,
          userAnswer: answer,
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

    // Check for high-score bonus from hopper — only every other delivery to avoid overuse
    if (this.transitionCount % 2 === 0) {
      const bonus = this._popHopperJoke(COMEDIAN_CONFIG.hopperMinScoreForBonus);
      if (bonus) {
        this.deps.queueSpeak("Oh wait, one more thing—", "emphasis", 0.7);
        this.deps.queueSpeak(bonus.text, bonus.motion, bonus.intensity);
        this._addLedger("joke", bonus.text, []);
        queued += 2;
      }
    }

    // Nothing was queued — advance immediately (don't wait for TTS drain that will never come)
    if (queued === 0) {
      this.deps.logTiming("brain: enterDelivering with nothing to say — advancing");
      this._onDeliveringDrained();
      return;
    }

    // Feed hopper with this context
    this._fireHopperGeneration("answer", undefined, answer);
  }

  private _onDeliveringDrained(): void {
    this.transitionCount++;

    // Follow-up takes priority over next question
    if (this.pendingFollowUp) {
      this._transition("ask_question");
      this.enterAskQuestion();
      return;
    }

    this.enterCheckVision();
  }

  private enterCheckVision(): void {
    this._transition("check_vision");
    const current = this.deps.getObservations();

    if (this.cameraAvailable && current.length > 0) {
      const { isInteresting, changes } = diffObservations(this.previousObservations, current);
      // Always update baseline — prevents diff accumulation from wording variation
      this.previousObservations = [...current];
      if (isInteresting) {
        this.enterVisionReact(changes, current);
        return;
      }
    }

    // Nothing interesting — next question
    this._transition("ask_question");
    this.enterAskQuestion();
  }

  private enterVisionReact(changes: string[], currentObs: string[]): void {
    this._transition("vision_react");
    this.deps.setMotion("shocked", 0.8);
    const frame = this.cameraAvailable ? this.deps.captureFrame() : undefined;

    // Check hopper for a vision joke first
    const hopperJoke = this._popHopperJoke(4, "vision");
    if (hopperJoke) {
      this.deps.queueSpeak(hopperJoke.text, hopperJoke.motion, hopperJoke.intensity);
      this._addLedger("joke", hopperJoke.text, []);
      // previousObservations already updated in enterCheckVision
      return;
    }

    this._generateJoke({
      context: "vision_react",
      observations: currentObs,
      previousObservations: this.previousObservations,
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

    const result = this._generateJoke(
      {
        context: "answer_roast",
        question: q?.question,
        userAnswer: snapshot,
        conversationSoFar,
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

  private _getLedgerContext(): string[] {
    return this.ledger.slice(-6).map(
      (e) => `[${e.type}] ${e.text}${e.tags.length ? ` (${e.tags.join(", ")})` : ""}`
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
  }

  private _getPersonaGreetings(): string[] {
    // Import inline to avoid circular deps — greetings are in personas.ts
    // We access them via a dynamic require pattern
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PERSONAS } = require("@/lib/personas") as { PERSONAS: Record<string, { greetings: string[] }> };
      return PERSONAS[this.deps.getPersona()]?.greetings ?? ["Hey there! Welcome!"];
    } catch {
      return ["Hey there! Welcome!"];
    }
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
      conversationSoFar?: string[];
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
      observations?: string[];
      previousObservations?: string[];
      conversationSoFar?: string[];
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
