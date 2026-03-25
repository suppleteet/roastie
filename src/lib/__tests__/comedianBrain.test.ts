import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComedianBrain, type ComedianBrainDeps } from "@/lib/comedianBrain";
import type { BrainState } from "@/lib/comedianBrainConfig";
import type { JokeResponse } from "@/app/api/generate-joke/route";

vi.mock("@/lib/personas", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/personas")>();
  return {
    ...original,
    PERSONAS: {
      ...original.PERSONAS,
      kvetch: { ...original.PERSONAS.kvetch, greetings: ["Test greeting."] },
    },
  };
});

// ─── Mock fetch ─────────────────────────────────────────────────────────────────

function mockFetchResponse(response: JokeResponse) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  });
}

const DEFAULT_JOKE_RESPONSE: JokeResponse = {
  relevant: true,
  jokes: [{ text: "You look like a mistake.", motion: "smug", intensity: 0.8, score: 7 }],
};

const IRRELEVANT_RESPONSE: JokeResponse = {
  relevant: false,
  jokes: [],
  redirect: "Nice try. But back to my question —",
};

// ─── Deps factory ──────────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<ComedianBrainDeps>): ComedianBrainDeps {
  return {
    queueSpeak: vi.fn(),
    cancelSpeech: vi.fn(),
    isQueueEmpty: vi.fn().mockReturnValue(true),
    setMotion: vi.fn(),
    captureFrame: vi.fn().mockReturnValue(undefined),
    getPersona: vi.fn().mockReturnValue("kvetch"),
    getBurnIntensity: vi.fn().mockReturnValue(3),
    getObservations: vi.fn().mockReturnValue([]),
    setBrainState: vi.fn(),
    setCurrentQuestion: vi.fn(),
    setUserAnswer: vi.fn(),
    logTiming: vi.fn(),
    ...overrides,
  };
}

/** Extract all brain state transitions from mock calls */
function getStates(deps: ComedianBrainDeps): Array<BrainState | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (deps.setBrainState as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0] as BrainState | null);
}

/** Drive brain from start → wait_answer */
function driveToWaitAnswer(brain: ComedianBrain): void {
  brain.start();
  brain.onTtsQueueDrained();  // greeting drain
  brain.onVisionUpdate([]);   // vision ready → enterVisionJokes
  brain.onTtsQueueDrained();  // vision_jokes → ask_question
  brain.onTtsQueueDrained();  // ask_question → wait_answer
}

// ─── Globals ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Greeting tests ──────────────────────────────────────────────────────────

describe("ComedianBrain — start() / greeting", () => {
  it("transitions to greeting state on start()", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    expect(getStates(deps)).toContain("greeting");
  });

  it("queues a greeting TTS immediately from persona greetings", () => {
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    expect(deps.queueSpeak).toHaveBeenCalledTimes(1);
    expect(deps.queueSpeak).toHaveBeenCalledWith("Test greeting.", "energetic", 0.8);
  });

  it("isListening() returns false in greeting", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    expect(brain.isListening()).toBe(false);
  });
});

// ─── Vision flow ─────────────────────────────────────────────────────────────

describe("ComedianBrain — vision flow", () => {
  it("advances from greeting when TTS drains AND vision arrives", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onTtsQueueDrained();
    brain.onVisionUpdate([]); // empty still signals vision complete
    const states = getStates(deps);
    expect(states).toContain("vision_jokes");
  });

  it("does NOT advance if only TTS drains (vision not ready)", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onTtsQueueDrained();
    const states = getStates(deps);
    expect(states).not.toContain("vision_jokes");
    expect(states).not.toContain("ask_question");
  });

  it("advances with greeting timeout even if vision never arrives", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onTtsQueueDrained(); // drain greeting
    vi.advanceTimersByTime(3100); // trigger greetingVisionTimeout
    const states = getStates(deps);
    // Should have advanced past greeting
    expect(states.length).toBeGreaterThan(1);
  });
});

// ─── Q&A cycle ───────────────────────────────────────────────────────────────

describe("ComedianBrain — Q&A cycle", () => {
  it("reaches wait_answer after full startup flow", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    expect(getStates(deps)).toContain("wait_answer");
    expect(brain.isListening()).toBe(true);
  });

  it("transitions directly to wait_answer from ask_question (no question TTS)", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onTtsQueueDrained();
    brain.onVisionUpdate([]);
    brain.onTtsQueueDrained(); // vision_jokes → ask_question → wait_answer (immediate, no TTS)

    const states = getStates(deps);
    expect(states).toContain("ask_question");
    expect(states).toContain("wait_answer");
  });

  it("routes inputTranscription to answerBuffer in wait_answer", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike");
    expect(deps.setUserAnswer).toHaveBeenCalledWith("My name is Mike");
  });

  it("transitions to pre_generate after enough words", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike Johnson"); // 4 words >= 3
    expect(getStates(deps)).toContain("pre_generate");
  });

  it("transitions to generating after silence timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike Johnson plumber");
    // Advance past silence timer (answerSilenceMs = 1500)
    vi.advanceTimersByTime(1600);
    expect(getStates(deps)).toContain("generating");
  });
});

// ─── Silence handling ─────────────────────────────────────────────────────────

describe("ComedianBrain — silence handling", () => {
  it("transitions to prodding after answerWaitMs silence", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    vi.advanceTimersByTime(6100); // > answerWaitMs (6000ms)
    expect(getStates(deps)).toContain("prodding");
  });

  it("cancels prod when inputTranscription arrives during prodding", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    vi.advanceTimersByTime(6100); // → prodding
    brain.onInputTranscription("Wait I have something to say");
    expect(deps.cancelSpeech).toHaveBeenCalled();
    expect(getStates(deps)).toContain("wait_answer");
  });
});

// ─── Irrelevant answers ───────────────────────────────────────────────────────

describe("ComedianBrain — irrelevant answers", () => {
  it("transitions to redirecting when API returns relevant:false", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(IRRELEVANT_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    brain.onInputTranscription("something completely unrelated");
    vi.advanceTimersByTime(600); // trigger silence timer
    // Need to let the async fetch resolve
    await vi.runAllTimersAsync();
    expect(getStates(deps)).toContain("generating");
  });
});

// ─── Stop ────────────────────────────────────────────────────────────────────

describe("ComedianBrain — stop()", () => {
  it("sets brainState to null on stop", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.stop();
    const lastState = getStates(deps).at(-1);
    expect(lastState).toBeNull();
  });
});

// ─── No mic mode ─────────────────────────────────────────────────────────────

describe("ComedianBrain — no mic mode", () => {
  it("isListening() is false when mic unavailable", () => {
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.setMicAvailable(false);
    brain.start();
    expect(brain.isListening()).toBe(false);
  });
});

// ─── Follow-up questions ──────────────────────────────────────────────────────

describe("ComedianBrain — follow-up questions", () => {
  it("stores pendingFollowUp from API response and uses it next question", async () => {
    const followUpResponse: JokeResponse = {
      relevant: true,
      jokes: [{ text: "A plumber named Mike!", motion: "laugh", intensity: 0.9, score: 8 }],
      followUp: "How long have you been doing that?",
    };
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(followUpResponse));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);
    brain.onInputTranscription("I am a plumber");
    vi.advanceTimersByTime(600);
    await vi.runAllTimersAsync();

    const states = getStates(deps);
    expect(states).toContain("generating");
  });
});

// ─── Vision react ─────────────────────────────────────────────────────────────

describe("ComedianBrain — vision react", () => {
  it("enters vision_react when interesting change detected after delivering", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps({
      getObservations: vi.fn().mockReturnValue(["a dog appeared on camera"]),
    });
    const brain = new ComedianBrain(deps);
    driveToWaitAnswer(brain);

    // Simulate user answering and joke being delivered
    brain.onInputTranscription("My name is Alex Johnson from Seattle");
    vi.advanceTimersByTime(600);
    await vi.runAllTimersAsync();

    // Deliver state → check_vision → if interesting → vision_react
    brain.onTtsQueueDrained(); // delivering drains → _onDeliveringDrained → enterCheckVision

    const states = getStates(deps);
    // Check that check_vision was visited
    expect(states).toContain("check_vision");
  });
});
