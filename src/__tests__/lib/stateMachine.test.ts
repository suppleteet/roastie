import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  transition,
  SESSION_TRANSITIONS,
  BRAIN_TRANSITIONS,
  BRAIN_STATE_CONFIG,
  BRAIN_MOTION_DEFAULTS,
  MOTION_TRANSITIONS,
} from "@/lib/stateMachine";
import type {
  SessionPhase,
  SessionTrigger,
  BrainState,
  BrainTrigger,
  MotionState,
} from "@/lib/stateMachine";

describe("transition()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns TransitionEvent for valid transitions", () => {
    const result = transition("idle", "consent", SESSION_TRANSITIONS, "START_CLICKED");
    expect(result).not.toBeNull();
    expect(result!.from).toBe("idle");
    expect(result!.to).toBe("consent");
    expect(result!.trigger).toBe("START_CLICKED");
    expect(result!.ts).toBeGreaterThan(0);
  });

  it("returns null for invalid transitions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = transition("idle", "sharing", SESSION_TRANSITIONS, "BAD");
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns null for self-transitions not in map", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = transition("idle", "idle", SESSION_TRANSITIONS, "NOOP");
    expect(result).toBeNull();
  });
});

describe("SESSION_TRANSITIONS", () => {
  const validPaths: [SessionPhase, SessionPhase, SessionTrigger][] = [
    ["idle", "consent", "START_CLICKED"],
    ["idle", "requesting-permissions", "START_CLICKED"],
    ["consent", "requesting-permissions", "CONSENT_ACCEPTED"],
    ["consent", "idle", "CONSENT_BACK"],
    ["requesting-permissions", "roasting", "PERMISSIONS_GRANTED"],
    ["requesting-permissions", "idle", "PERMISSIONS_DENIED"],
    ["roasting", "stopped", "STOP_CLICKED"],
    ["stopped", "roasting", "SESSION_RESTART"],
    ["stopped", "sharing", "SHARE_CLICKED"],
    ["stopped", "idle", "RESET"],
    ["sharing", "idle", "SHARE_DISMISSED"],
  ];

  it.each(validPaths)("%s → %s (%s) is valid", (from, to, trigger) => {
    expect(transition(from, to, SESSION_TRANSITIONS, trigger)).not.toBeNull();
  });

  const invalidPaths: [SessionPhase, SessionPhase][] = [
    ["idle", "roasting"],
    ["idle", "stopped"],
    ["idle", "sharing"],
    ["consent", "roasting"],
    ["roasting", "sharing"],
    ["sharing", "roasting"],
    ["sharing", "stopped"],
  ];

  it.each(invalidPaths)("%s → %s is invalid", (from, to) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(transition(from, to, SESSION_TRANSITIONS, "TEST")).toBeNull();
  });
});

describe("BRAIN_TRANSITIONS", () => {
  it("happy path: greeting through full cycle", () => {
    const happyPath: [BrainState, BrainState, BrainTrigger][] = [
      ["greeting", "vision_jokes", "VISION_READY"],
      ["vision_jokes", "ask_question", "VISION_JOKES_DONE"],
      ["ask_question", "wait_answer", "QUESTION_ASKED"],
      ["wait_answer", "pre_generate", "SPECULATIVE_THRESHOLD"],
      ["pre_generate", "generating", "VAD_SPEECH_END"],
      ["generating", "delivering", "FIRST_JOKE_STREAMED"],
      ["delivering", "check_vision", "DELIVERY_DRAINED"],
      ["check_vision", "vision_react", "VISION_INTERESTING"],
      ["vision_react", "ask_question", "VISION_REACT_DONE"],
    ];

    for (const [from, to, trigger] of happyPath) {
      expect(transition(from, to, BRAIN_TRANSITIONS, trigger)).not.toBeNull();
    }
  });

  it("alternate paths are valid", () => {
    // Skip vision → ask_question directly
    expect(transition("greeting", "ask_question", BRAIN_TRANSITIONS, "NO_CAMERA")).not.toBeNull();
    // Silence → prodding
    expect(transition("wait_answer", "prodding", BRAIN_TRANSITIONS, "SILENCE_TIMEOUT")).not.toBeNull();
    // Prod exhausted → check_vision
    expect(transition("prodding", "check_vision", BRAIN_TRANSITIONS, "PROD_EXHAUSTED")).not.toBeNull();
    // Irrelevant answer → redirecting
    expect(transition("generating", "redirecting", BRAIN_TRANSITIONS, "ANSWER_IRRELEVANT")).not.toBeNull();
    // Redirect → re-ask
    expect(transition("redirecting", "wait_answer", BRAIN_TRANSITIONS, "REDIRECT_DRAINED")).not.toBeNull();
    // Vision boring → next question
    expect(transition("check_vision", "ask_question", BRAIN_TRANSITIONS, "VISION_BORING")).not.toBeNull();
    // Follow-up → ask_question
    expect(transition("delivering", "ask_question", BRAIN_TRANSITIONS, "FOLLOW_UP")).not.toBeNull();
    // Vision-only mode
    expect(transition("ask_question", "check_vision", BRAIN_TRANSITIONS, "VISION_ONLY_MODE")).not.toBeNull();
  });

  it("invalid brain transitions are rejected", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Can't jump from greeting to delivering
    expect(transition("greeting", "delivering", BRAIN_TRANSITIONS, "BAD")).toBeNull();
    // Can't go from delivering to greeting
    expect(transition("delivering", "greeting", BRAIN_TRANSITIONS, "BAD")).toBeNull();
    // Can't go from wait_answer directly to delivering
    expect(transition("wait_answer", "delivering", BRAIN_TRANSITIONS, "BAD")).toBeNull();
  });

  it("every state in BRAIN_STATE_CONFIG matches BRAIN_TRANSITIONS keys", () => {
    const transitionKeys = Object.keys(BRAIN_TRANSITIONS).sort();
    const configKeys = Object.keys(BRAIN_STATE_CONFIG).sort();
    expect(transitionKeys).toEqual(configKeys);
  });

  it("every state in BRAIN_MOTION_DEFAULTS matches BRAIN_TRANSITIONS keys", () => {
    const transitionKeys = Object.keys(BRAIN_TRANSITIONS).sort();
    const motionKeys = Object.keys(BRAIN_MOTION_DEFAULTS).sort();
    expect(transitionKeys).toEqual(motionKeys);
  });
});

describe("MOTION_TRANSITIONS", () => {
  it("allows any-to-any transitions", () => {
    const states: MotionState[] = [
      "idle", "laugh", "energetic", "smug", "conspiratorial",
      "shocked", "emphasis", "thinking", "listening", "sleeping",
    ];
    for (const from of states) {
      for (const to of states) {
        expect(transition(from, to, MOTION_TRANSITIONS, "TEST")).not.toBeNull();
      }
    }
  });
});
