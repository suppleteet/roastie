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

describe("burn intensity and content mode", () => {
  it("setBurnIntensity updates intensity", () => {
    useSessionStore.getState().setBurnIntensity(2);
    expect(useSessionStore.getState().burnIntensity).toBe(2);
  });

  it("setContentMode switches to vulgar", () => {
    useSessionStore.getState().setContentMode("vulgar");
    expect(useSessionStore.getState().contentMode).toBe("vulgar");
  });
});

describe("audio amplitude", () => {
  it("setAudioAmplitude updates the value", () => {
    useSessionStore.getState().setAudioAmplitude(0.75);
    expect(useSessionStore.getState().audioAmplitude).toBe(0.75);
  });
});

describe("vision setting", () => {
  it("setVisionSetting stores a setting string", () => {
    useSessionStore.getState().setVisionSetting("home office");
    expect(useSessionStore.getState().visionSetting).toBe("home office");
  });

  it("setVisionSetting accepts null to clear", () => {
    useSessionStore.getState().setVisionSetting("bedroom");
    useSessionStore.getState().setVisionSetting(null);
    expect(useSessionStore.getState().visionSetting).toBeNull();
  });
});

describe("conversation events", () => {
  it("addConversationEvent appends an event", () => {
    useSessionStore.getState().addConversationEvent("user-start", "hello");
    const events = useSessionStore.getState().conversationEvents;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user-start");
    expect(events[0].text).toBe("hello");
  });

  it("clearConversationEvents empties the list", () => {
    useSessionStore.getState().addConversationEvent("ai-speech");
    useSessionStore.getState().clearConversationEvents();
    expect(useSessionStore.getState().conversationEvents).toHaveLength(0);
  });
});

describe("comedian brain fields", () => {
  it("setBrainState updates the brain state", () => {
    useSessionStore.getState().setBrainState("wait_answer");
    expect(useSessionStore.getState().brainState).toBe("wait_answer");
  });

  it("setCurrentQuestion stores the question text", () => {
    useSessionStore.getState().setCurrentQuestion("What do you do for a living?");
    expect(useSessionStore.getState().currentQuestion).toBe("What do you do for a living?");
  });

  it("setUserAnswer stores the answer", () => {
    useSessionStore.getState().setUserAnswer("I'm a dentist");
    expect(useSessionStore.getState().userAnswer).toBe("I'm a dentist");
  });

  it("setIsUserLaughing toggles laughing state", () => {
    useSessionStore.getState().setIsUserLaughing(true);
    expect(useSessionStore.getState().isUserLaughing).toBe(true);
    useSessionStore.getState().setIsUserLaughing(false);
    expect(useSessionStore.getState().isUserLaughing).toBe(false);
  });

  it("setHasSpokenThisSession marks first speech", () => {
    useSessionStore.getState().setHasSpokenThisSession(true);
    expect(useSessionStore.getState().hasSpokenThisSession).toBe(true);
  });

  it("setTimeToFirstSpeechMs stores a value and can be cleared", () => {
    useSessionStore.getState().setTimeToFirstSpeechMs(1234);
    expect(useSessionStore.getState().timeToFirstSpeechMs).toBe(1234);
    useSessionStore.getState().setTimeToFirstSpeechMs(null);
    expect(useSessionStore.getState().timeToFirstSpeechMs).toBeNull();
  });

  it("setLastVisionCallTs stores a timestamp", () => {
    const now = Date.now();
    useSessionStore.getState().setLastVisionCallTs(now);
    expect(useSessionStore.getState().lastVisionCallTs).toBe(now);
  });
});

describe("transcript history", () => {
  it("pushTranscriptEntry appends puppet and user entries", () => {
    useSessionStore.getState().pushTranscriptEntry("puppet", "Hello there!");
    useSessionStore.getState().pushTranscriptEntry("user", "Hi");
    const history = useSessionStore.getState().transcriptHistory;
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("puppet");
    expect(history[0].text).toBe("Hello there!");
    expect(history[1].role).toBe("user");
  });

  it("clearTranscriptHistory empties the list", () => {
    useSessionStore.getState().pushTranscriptEntry("puppet", "test");
    useSessionStore.getState().clearTranscriptHistory();
    expect(useSessionStore.getState().transcriptHistory).toHaveLength(0);
  });

  it("assigns a unique groupId to each non-append entry", () => {
    useSessionStore.getState().clearTranscriptHistory();
    useSessionStore.getState().pushTranscriptEntry("puppet", "First joke");
    useSessionStore.getState().pushTranscriptEntry("puppet", "Different batch");
    const history = useSessionStore.getState().transcriptHistory;
    expect(history).toHaveLength(2);
    expect(history[0].groupId).toBeTruthy();
    expect(history[1].groupId).toBeTruthy();
    expect(history[0].groupId).not.toBe(history[1].groupId);
  });

  it("append=true shares the previous same-role entry's groupId", () => {
    useSessionStore.getState().clearTranscriptHistory();
    useSessionStore.getState().pushTranscriptEntry("puppet", "Joke 1");
    useSessionStore.getState().pushTranscriptEntry("puppet", "Joke 2", { append: true });
    const history = useSessionStore.getState().transcriptHistory;
    expect(history).toHaveLength(2);
    expect(history[0].groupId).toBe(history[1].groupId);
    expect(history[0].text).toBe("Joke 1");
    expect(history[1].text).toBe("Joke 2");
  });

  it("append=true starts a new group when previous entry has different role", () => {
    useSessionStore.getState().clearTranscriptHistory();
    useSessionStore.getState().pushTranscriptEntry("user", "I dunno");
    useSessionStore.getState().pushTranscriptEntry("puppet", "Joke after user", { append: true });
    const history = useSessionStore.getState().transcriptHistory;
    expect(history[0].groupId).not.toBe(history[1].groupId);
  });
});

describe("timeline spans", () => {
  it("beginSpan returns an id and stores the span", () => {
    const id = useSessionStore.getState().beginSpan("tts", "speaking");
    const spans = useSessionStore.getState().timelineSpans;
    expect(spans).toHaveLength(1);
    expect(spans[0].id).toBe(id);
    expect(spans[0].row).toBe("tts");
    expect(spans[0].label).toBe("speaking");
    expect(spans[0].endTs).toBeNull();
  });

  it("endSpan sets endTs on the matching span", () => {
    const id = useSessionStore.getState().beginSpan("gemini", "generating");
    useSessionStore.getState().endSpan(id);
    const span = useSessionStore.getState().timelineSpans.find((s) => s.id === id);
    expect(span?.endTs).not.toBeNull();
  });

  it("clearTimelineSpans empties all spans", () => {
    useSessionStore.getState().beginSpan("user", "talking");
    useSessionStore.getState().clearTimelineSpans();
    expect(useSessionStore.getState().timelineSpans).toHaveLength(0);
  });
});

describe("debug transcription", () => {
  it("submitDebugTranscription sets pendingDebugTranscription", () => {
    useSessionStore.getState().submitDebugTranscription("test input");
    expect(useSessionStore.getState().pendingDebugTranscription).toBe("test input");
  });

  it("clearPendingDebugTranscription nulls it out", () => {
    useSessionStore.getState().submitDebugTranscription("hello");
    useSessionStore.getState().clearPendingDebugTranscription();
    expect(useSessionStore.getState().pendingDebugTranscription).toBeNull();
  });
});

describe("smile and laugh metrics", () => {
  it("setIsUserSmiling toggles smiling state", () => {
    useSessionStore.getState().setIsUserSmiling(true);
    expect(useSessionStore.getState().isUserSmiling).toBe(true);
    useSessionStore.getState().setIsUserSmiling(false);
    expect(useSessionStore.getState().isUserSmiling).toBe(false);
  });

  it("incrementLaughCount increments the counter", () => {
    expect(useSessionStore.getState().laughCount).toBe(0);
    useSessionStore.getState().incrementLaughCount();
    useSessionStore.getState().incrementLaughCount();
    expect(useSessionStore.getState().laughCount).toBe(2);
  });

  it("recordVisionFrame tracks total frames and smile frames", () => {
    useSessionStore.getState().recordVisionFrame(true);
    useSessionStore.getState().recordVisionFrame(false);
    useSessionStore.getState().recordVisionFrame(true);
    const s = useSessionStore.getState();
    expect(s.totalVisionFrames).toBe(3);
    expect(s.smileFrames).toBe(2);
  });

  it("reset clears all metrics", () => {
    useSessionStore.getState().incrementLaughCount();
    useSessionStore.getState().recordVisionFrame(true);
    useSessionStore.getState().setIsUserSmiling(true);
    useSessionStore.getState().reset();
    const s = useSessionStore.getState();
    expect(s.laughCount).toBe(0);
    expect(s.smileFrames).toBe(0);
    expect(s.totalVisionFrames).toBe(0);
    expect(s.isUserSmiling).toBe(false);
  });
});

describe("session start timestamp", () => {
  it("setSessionStartTs stores a timestamp", () => {
    const ts = Date.now();
    useSessionStore.getState().setSessionStartTs(ts);
    expect(useSessionStore.getState().sessionStartTs).toBe(ts);
  });

  it("setSessionStartTs accepts null", () => {
    useSessionStore.getState().setSessionStartTs(Date.now());
    useSessionStore.getState().setSessionStartTs(null);
    expect(useSessionStore.getState().sessionStartTs).toBeNull();
  });
});
