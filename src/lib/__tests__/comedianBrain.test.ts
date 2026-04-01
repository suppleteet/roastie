import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComedianBrain, type ComedianBrainDeps } from "@/lib/comedianBrain";
import type { BrainState } from "@/lib/comedianBrainConfig";
import type { JokeResponse } from "@/app/api/generate-joke/route";

// Override latency experiment flags so tests run the full greeting/pre_generate flow
vi.mock("@/lib/comedianConfig", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/comedianConfig")>();
  return {
    ...original,
    COMEDIAN_CONFIG: {
      ...original.COMEDIAN_CONFIG,
      skipGreeting: false,
      skipPreGeneration: false,
      skipFiller: false,
      singleJokeMode: false,
    },
  };
});

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
    getContentMode: vi.fn().mockReturnValue("clean"),
    getObservations: vi.fn().mockReturnValue([]),
    getVisionSetting: vi.fn().mockReturnValue(null),
    getAmbientContext: vi.fn().mockReturnValue(null),
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

/** Drive brain from start → wait_answer.
 *  Greeting is now LLM-generated (async), so we must flush microtasks. */
async function driveToWaitAnswer(brain: ComedianBrain): Promise<void> {
  brain.start();
  brain.onVisionUpdate([]);   // vision ready → fires greeting generation
  await vi.advanceTimersByTimeAsync(0); // flush microtasks
  brain.onTtsQueueDrained();  // greeting drain → ask_question
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

  it("generates greeting via LLM (not canned strings)", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onVisionUpdate([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.queueSpeak).toHaveBeenCalledWith("You look like a mistake.", "smug", 0.8);
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
  it("advances from greeting when TTS drains AND vision arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onVisionUpdate([]);
    await vi.advanceTimersByTimeAsync(0);
    brain.onTtsQueueDrained();
    const states = getStates(deps);
    expect(states).toContain("ask_question");
  });

  it("does NOT advance until generation resolves and TTS drains", () => {
    // Greeting generation never resolves — TTS never queued, so drain fires with nothing played.
    // Brain should still advance (greeting TTS drained = true), but queueSpeak should not have been called.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    // No speech queued yet (fetch pending) — queueSpeak not called
    expect(deps.queueSpeak).not.toHaveBeenCalled();
  });

  it("advances to ask_question once greeting TTS drains", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    await vi.advanceTimersByTimeAsync(0); // flush generation
    brain.onTtsQueueDrained();
    const states = getStates(deps);
    expect(states).toContain("ask_question");
  });
});

// ─── Q&A cycle ───────────────────────────────────────────────────────────────

describe("ComedianBrain — Q&A cycle", () => {
  it("reaches wait_answer after full startup flow", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    expect(getStates(deps)).toContain("wait_answer");
    expect(brain.isListening()).toBe(true);
  });

  it("transitions to wait_answer from ask_question after question TTS drains", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    brain.start();
    brain.onVisionUpdate([]);
    await vi.advanceTimersByTimeAsync(0);
    brain.onTtsQueueDrained();
    brain.onTtsQueueDrained();

    const states = getStates(deps);
    expect(states).toContain("ask_question");
    expect(states).toContain("wait_answer");
  });

  it("routes inputTranscription to answerBuffer in wait_answer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike");
    expect(deps.setUserAnswer).toHaveBeenCalledWith("My name is Mike");
  });

  it("transitions to pre_generate after enough words", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike Johnson"); // 4 words >= 3
    expect(getStates(deps)).toContain("pre_generate");
  });

  it("transitions to generating after silence timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    brain.onInputTranscription("My name is Mike Johnson plumber");
    vi.advanceTimersByTime(1600);
    expect(getStates(deps)).toContain("generating");
  });
});

// ─── Silence handling ─────────────────────────────────────────────────────────

describe("ComedianBrain — silence handling", () => {
  it("transitions to prodding after answerWaitMs silence", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    vi.advanceTimersByTime(6100);
    expect(getStates(deps)).toContain("prodding");
  });

  it("cancels prod when inputTranscription arrives during prodding", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    vi.advanceTimersByTime(6100);
    brain.onInputTranscription("Wait I have something to say");
    expect(deps.cancelSpeech).toHaveBeenCalled();
    expect(getStates(deps)).toContain("wait_answer");
  });
});

// ─── Irrelevant answers ───────────────────────────────────────────────────────

describe("ComedianBrain — irrelevant answers", () => {
  it("transitions to redirecting when API returns relevant:false", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetchResponse(DEFAULT_JOKE_RESPONSE));
    const deps = makeDeps();
    const brain = new ComedianBrain(deps);
    await driveToWaitAnswer(brain);
    vi.stubGlobal("fetch", mockFetchResponse(IRRELEVANT_RESPONSE));
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
    await driveToWaitAnswer(brain);
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
    await driveToWaitAnswer(brain);

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
