import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "@/store/useSessionStore";

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe("initial state", () => {
  it("starts in idle phase", () => {
    expect(useSessionStore.getState().phase).toBe("idle");
  });

  it("starts with burnIntensity 5", () => {
    expect(useSessionStore.getState().burnIntensity).toBe(5);
  });

  it("starts not speaking", () => {
    expect(useSessionStore.getState().isSpeaking).toBe(false);
  });

  it("starts with zero audioAmplitude", () => {
    expect(useSessionStore.getState().audioAmplitude).toBe(0);
  });

  it("starts with empty timingLog", () => {
    expect(useSessionStore.getState().timingLog).toHaveLength(0);
  });

  it("starts with no error", () => {
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("starts with empty observations", () => {
    expect(useSessionStore.getState().observations).toHaveLength(0);
  });
});

describe("phase transitions", () => {
  it("setPhase transitions through a valid phase sequence", () => {
    const { setPhase } = useSessionStore.getState();
    const steps: [string, string][] = [
      ["consent", "START_CLICKED"],
      ["requesting-permissions", "CONSENT_ACCEPTED"],
      ["roasting", "PERMISSIONS_GRANTED"],
      ["stopped", "STOP_CLICKED"],
      ["sharing", "SHARE_CLICKED"],
      ["idle", "SHARE_DISMISSED"],
    ];
    for (const [phase, trigger] of steps) {
      setPhase(phase as Parameters<typeof setPhase>[0], trigger as Parameters<typeof setPhase>[1]);
      expect(useSessionStore.getState().phase).toBe(phase);
    }
  });

  it("rejects invalid transitions silently", () => {
    const { setPhase } = useSessionStore.getState();
    // idle → sharing is invalid
    setPhase("sharing", "SHARE_CLICKED");
    expect(useSessionStore.getState().phase).toBe("idle");
  });
});

describe("timingLog", () => {
  it("logTiming appends entries with relative timestamp prefix", () => {
    const { logTiming } = useSessionStore.getState();
    logTiming("entry one");
    logTiming("entry two");
    const { timingLog } = useSessionStore.getState();
    expect(timingLog.some((l) => l.includes("entry one"))).toBe(true);
    expect(timingLog.some((l) => l.includes("entry two"))).toBe(true);
  });

  it("caps at 500 entries (slice(-499) + 1 new)", () => {
    const { logTiming } = useSessionStore.getState();
    for (let i = 0; i < 510; i++) {
      logTiming(`entry ${i}`);
    }
    expect(useSessionStore.getState().timingLog).toHaveLength(500);
  });

  it("clearTimingLog empties the log", () => {
    const { logTiming, clearTimingLog } = useSessionStore.getState();
    logTiming("something");
    clearTimingLog();
    expect(useSessionStore.getState().timingLog).toHaveLength(0);
  });
});

describe("motion state", () => {
  it("setActiveMotionState updates state and intensity together", () => {
    useSessionStore.getState().setActiveMotionState("laugh", 0.9);
    const { activeMotionState, motionIntensity } = useSessionStore.getState();
    expect(activeMotionState).toBe("laugh");
    expect(motionIntensity).toBe(0.9);
  });
});

describe("observations", () => {
  it("setObservations replaces the array", () => {
    useSessionStore.getState().setObservations(["big nose", "tired eyes"]);
    expect(useSessionStore.getState().observations).toEqual(["big nose", "tired eyes"]);

    useSessionStore.getState().setObservations(["new obs"]);
    expect(useSessionStore.getState().observations).toHaveLength(1);
  });
});

describe("session mode", () => {
  it("defaults to conversation mode", () => {
    expect(useSessionStore.getState().sessionMode).toBe("conversation");
  });

  it("setSessionMode switches to monologue", () => {
    useSessionStore.getState().setSessionMode("monologue");
    expect(useSessionStore.getState().sessionMode).toBe("monologue");
  });
});

describe("conversation state", () => {
  it("setIsListening toggles listening state", () => {
    useSessionStore.getState().setIsListening(true);
    expect(useSessionStore.getState().isListening).toBe(true);
    useSessionStore.getState().setIsListening(false);
    expect(useSessionStore.getState().isListening).toBe(false);
  });

  it("setIsUserSpeaking toggles user speaking state", () => {
    useSessionStore.getState().setIsUserSpeaking(true);
    expect(useSessionStore.getState().isUserSpeaking).toBe(true);
  });

  it("setTranscript updates transcript text", () => {
    useSessionStore.getState().setTranscript("hello world");
    expect(useSessionStore.getState().transcript).toBe("hello world");
  });
});

describe("persona", () => {
  it("setActivePersona updates the active persona", () => {
    useSessionStore.getState().setActivePersona("kvetch");
    expect(useSessionStore.getState().activePersona).toBe("kvetch");
  });
});

describe("scene and recording", () => {
  it("setLastSceneJson stores scene data", () => {
    useSessionStore.getState().setLastSceneJson('{"test":true}');
    expect(useSessionStore.getState().lastSceneJson).toBe('{"test":true}');
  });

  it("setRecordedBlob stores a blob", () => {
    const blob = new Blob(["test"], { type: "video/webm" });
    useSessionStore.getState().setRecordedBlob(blob);
    expect(useSessionStore.getState().recordedBlob).toBe(blob);
  });
});

describe("reset", () => {
  it("returns all fields to initial values", () => {
    const store = useSessionStore.getState();
    // Walk through valid transitions to reach roasting
    store.setPhase("consent", "START_CLICKED");
    store.setPhase("requesting-permissions", "CONSENT_ACCEPTED");
    store.setPhase("roasting", "PERMISSIONS_GRANTED");
    store.setSessionMode("monologue");
    store.setBurnIntensity(5);
    store.setIsSpeaking(true);
    store.setIsListening(true);
    store.setIsUserSpeaking(true);
    store.setTranscript("some transcript");
    store.setError("something went wrong");
    store.logTiming("log entry");
    store.setObservations(["obs1"]);
    store.setActiveMotionState("laugh", 1.0);

    store.reset();

    const after = useSessionStore.getState();
    expect(after.phase).toBe("idle");
    expect(after.sessionMode).toBe("conversation");
    expect(after.burnIntensity).toBe(5);
    expect(after.isSpeaking).toBe(false);
    expect(after.isListening).toBe(false);
    expect(after.isUserSpeaking).toBe(false);
    expect(after.transcript).toBe("");
    expect(after.error).toBeNull();
    expect(after.timingLog).toHaveLength(0);
    expect(after.observations).toHaveLength(0);
  });
});
