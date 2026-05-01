import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComedianBrain, type ComedianBrainDeps } from "@/lib/comedianBrain";

// Mock COMEDIAN_CONFIG at module level (evaluated at import time)
vi.mock("@/lib/comedianConfig", () => ({
  COMEDIAN_CONFIG: {
    answerSilenceMs: 30,
    unfinalizedAnswerSilenceMs: 80,
    answerWaitMs: 50,
    earlyListenMs: 20,
    visionIntervalMs: 100,
    greetingVisionTimeoutMs: 50,
    maxProds: 1,
    speculativeMinWords: 1,
    hopperMaxSize: 8,
    hopperMinScoreForBonus: 8,
    hopperMinScoreForFallback: 6,
    hopperStalenessMs: 60000,
    silentQuestionsBeforeVisionMode: 2,
    jokesPerAnswer: { min: 1, max: 2 },
    jokesPerVisionOpen: { min: 1, max: 1 },
    callbackOpportunityEveryN: 3,
    generatedGreetingCount: 4,
    devNotesEnabled: false,
    devNoteTimeoutMs: 60000,
    skipGreeting: true,
    skipPreGeneration: false,
    skipFiller: false,
    singleJokeMode: true,
  },
}));

/** Create mock deps */
function makeDeps(overrides?: Partial<ComedianBrainDeps>): ComedianBrainDeps {
  return {
    queueSpeak: vi.fn(),
    cancelSpeech: vi.fn(),
    isQueueEmpty: vi.fn(() => true),
    setMotion: vi.fn(),
    captureFrame: vi.fn(() => undefined),
    getPersona: vi.fn(() => "kvetch" as const),
    getBurnIntensity: vi.fn(() => 5 as 1 | 2 | 3 | 4 | 5),
    getContentMode: vi.fn(() => "vulgar" as const),
    getRoastModel: vi.fn(() => "gemini-2.5-flash"),
    getInputAmplitude: vi.fn(() => 0.1),
    getObservations: vi.fn(() => []),
    getVisionSetting: vi.fn(() => null),
    getAmbientContext: vi.fn(() => null),
    getTownFlavor: vi.fn(() => null),
    getSessionId: vi.fn(() => null),
    setBrainState: vi.fn(),
    setCurrentQuestion: vi.fn(),
    setUserAnswer: vi.fn(),
    logTiming: vi.fn(),
    revealSession: vi.fn(),
    ...overrides,
  };
}

// Mock fetch for API calls the brain makes internally
const mockFetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ jokes: [], relevant: true }),
    text: () => Promise.resolve(""),
    body: null,
  } as unknown as Response),
);

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: get all values passed to setBrainState */
function stateHistory(deps: ComedianBrainDeps): (string | null)[] {
  return (deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => c[0] as string | null,
  );
}

describe("ComedianBrain", () => {
  describe("construction", () => {
    it("creates without error", () => {
      const brain = new ComedianBrain(makeDeps());
      expect(brain).toBeDefined();
    });
  });

  describe("filler delivery", () => {
    it("echoes complete answers as active-listening filler", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const brain = new ComedianBrain(makeDeps()) as unknown as {
        _pickFiller: (answer: string) => string;
      };

      expect(brain._pickFiller("Gerard.")).toBe("Gerard, huh.");
    });

    it("removes a repeated answer lead from a joke after echo filler", () => {
      const brain = new ComedianBrain(makeDeps()) as unknown as {
        _removeEchoedAnswerLead: (text: string, answer: string, filler?: string) => string;
      };

      expect(
        brain._removeEchoedAnswerLead(
          "Gerard. Nobody under sixty has that name by accident.",
          "Gerard.",
          "Gerard, huh.",
        ),
      ).toBe("Nobody under sixty has that name by accident.");
    });
  });

  describe("start() with skipGreeting", () => {
    it("transitions to ask_question", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      expect(stateHistory(deps)).toContain("ask_question");
    });

    it("sets a question once the queued wording is chosen", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(deps.setCurrentQuestion).toHaveBeenCalled();
      const q = (deps.setCurrentQuestion as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(typeof q).toBe("string");
    });

    it("queues question speech", async () => {
      vi.useFakeTimers();
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      // _queueQuestionWithBridge races rephrase vs timeout — flush microtasks
      await vi.advanceTimersByTimeAsync(1600);
      expect(deps.queueSpeak).toHaveBeenCalled();
    });
  });

  describe("stop()", () => {
    it("sets brain state to null", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.stop();
      expect(deps.setBrainState).toHaveBeenCalledWith(null);
    });

    it("disables mic", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.stop();
      expect(brain.isAudioActive()).toBe(false);
    });
  });

  describe("isListening / isAudioActive", () => {
    it("mic is off before start()", () => {
      const brain = new ComedianBrain(makeDeps());
      expect(brain.isListening()).toBe(false);
      expect(brain.isAudioActive()).toBe(false);
    });

    it("mic is passive in ask_question (skipGreeting)", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      // ask_question sets mic to passive
      expect(brain.isAudioActive()).toBe(true);
      expect(brain.isListening()).toBe(false);
    });
  });

  describe("onTtsQueueDrained()", () => {
    it("transitions from ask_question to wait_answer", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start(); // → ask_question
      brain.onTtsQueueDrained(); // question finished → wait_answer
      expect(stateHistory(deps)).toContain("wait_answer");
    });

    it("sets mic to listening in wait_answer", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      brain.onTtsQueueDrained();
      expect(brain.isListening()).toBe(true);
    });
  });

  describe("onInputTranscription()", () => {
    it("buffers text in wait_answer state", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.onTtsQueueDrained(); // → wait_answer

      brain.onInputTranscription("Hello");
      expect(deps.setUserAnswer).toHaveBeenCalled();
      const lastCall = (deps.setUserAnswer as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(lastCall?.[0]).toContain("Hello");
    });

    it("transitions to pre_generate when enough words", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.onTtsQueueDrained(); // → wait_answer

      brain.onInputTranscription("My name is Bob");
      expect(stateHistory(deps)).toContain("pre_generate");
    });

    it("waits longer for unfinalized multi-word answers before generating", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        const brain = new ComedianBrain(deps);
        brain.start();
        brain.onTtsQueueDrained();

        brain.onInputTranscription("I work");
        await vi.advanceTimersByTimeAsync(40);
        expect(stateHistory(deps)).not.toContain("generating");

        brain.onInputTranscription("at a company");
        await vi.advanceTimersByTimeAsync(40);
        expect(stateHistory(deps)).not.toContain("generating");

        await vi.advanceTimersByTimeAsync(80);
        expect(stateHistory(deps)).toContain("generating");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not immediately commit an unfinalized sentence starter", async () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        const brain = new ComedianBrain(deps);
        brain.start();
        brain.onTtsQueueDrained();

        brain.onInputTranscription("I");
        await vi.advanceTimersByTimeAsync(40);

        expect(stateHistory(deps)).not.toContain("generating");
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores empty text", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.onTtsQueueDrained();

      const callsBefore = (deps.setUserAnswer as ReturnType<typeof vi.fn>).mock.calls.length;
      brain.onInputTranscription("   ");
      const callsAfter = (deps.setUserAnswer as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBe(callsBefore);
    });

    it("buffers text during ask_question (early answer)", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start(); // → ask_question

      brain.activateEarlyListen(); // gate opens once question TTS is nearly done
      brain.onInputTranscription("Tyler");
      expect(deps.setUserAnswer).toHaveBeenCalled();
      expect(deps.logTiming).toHaveBeenCalledWith(
        expect.stringContaining("early answer"),
      );
    });
  });

  describe("onVadSpeechEnd()", () => {
    it("completes answer when buffer has text", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.onTtsQueueDrained(); // → wait_answer

      brain.onInputTranscription("Tyler");
      brain.onVadSpeechEnd();

      // Should transition to generating
      expect(stateHistory(deps)).toContain("generating");
    });

    it("defers VAD completion until final STT when answer is 3+ words", () => {
      vi.useFakeTimers();
      try {
        const deps = makeDeps();
        const brain = new ComedianBrain(deps);
        brain.start();
        brain.onTtsQueueDrained(); // → wait_answer

        brain.onInputTranscription("I work in accounting"); // partial / no finished flag yet
        brain.onVadSpeechEnd();
        expect(stateHistory(deps)).not.toContain("generating");

        brain.onInputTranscription("I work in accounting downtown.", true);
        expect(stateHistory(deps)).toContain("generating");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does nothing when buffer is empty", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start();
      brain.onTtsQueueDrained(); // → wait_answer

      const callsBefore = (deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.length;
      brain.onVadSpeechEnd();
      expect((deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it("does nothing in wrong state (ask_question)", () => {
      const deps = makeDeps();
      const brain = new ComedianBrain(deps);
      brain.start(); // → ask_question

      const callsBefore = (deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.length;
      brain.onVadSpeechEnd();
      expect((deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });
  });

  describe("activateEarlyListen()", () => {
    it("switches mic to listening in ask_question state", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start(); // → ask_question
      expect(brain.isListening()).toBe(false);
      brain.activateEarlyListen();
      expect(brain.isListening()).toBe(true);
    });

    it("does nothing when already listening", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      brain.onTtsQueueDrained(); // → wait_answer, mic = listening
      expect(brain.isListening()).toBe(true);
      brain.activateEarlyListen(); // should be no-op
      expect(brain.isListening()).toBe(true);
    });
  });

  describe("setMicAvailable / setCameraAvailable", () => {
    it("can be called without error", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.setMicAvailable(true);
      brain.setCameraAvailable(false);
    });
  });

  describe("onInterrupted()", () => {
    it("does not crash in any state", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      expect(() => brain.onInterrupted()).not.toThrow();
    });
  });

  describe("onVisionUpdate()", () => {
    it("accepts empty observations", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      expect(() => brain.onVisionUpdate([])).not.toThrow();
    });

    it("accepts observations", () => {
      const brain = new ComedianBrain(makeDeps());
      brain.start();
      expect(() => brain.onVisionUpdate(["wearing glasses", "smiling"])).not.toThrow();
    });
  });
});
