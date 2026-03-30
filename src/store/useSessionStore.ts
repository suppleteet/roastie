import { create } from "zustand";
import type { MotionState } from "@/lib/stateMachine";
import type { BurnIntensity } from "@/lib/prompts";
import { DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { BrainState } from "@/lib/stateMachine";
import {
  transition,
  SESSION_TRANSITIONS,
  type SessionPhase,
  type SessionTrigger,
} from "@/lib/stateMachine";

export type ContentMode = "clean" | "vulgar";

export type ConversationEventType = "user-start" | "user-end" | "ai-speech" | "ai-done" | "interrupted" | "listening" | "rotate" | "user-laugh";

export type TimelineRow = "user" | "gemini" | "tts" | "vision" | "session";

export const TIMELINE_ROW_COLORS: Record<TimelineRow, string> = {
  user: "#22d3ee",
  gemini: "#fb923c",
  tts: "#a78bfa",
  vision: "#60a5fa",
  session: "#94a3b8",
};

export interface TimelineSpan {
  id: string;
  row: TimelineRow;
  label: string;
  startTs: number;
  endTs: number | null;
  color: string;
}

export interface ConversationEvent {
  type: ConversationEventType;
  text?: string;
  ts: number;
}

// SessionPhase is now defined in @/lib/stateMachine/sessionPhase.ts
// Re-export for backwards compatibility
export type { SessionPhase } from "@/lib/stateMachine";

export type SessionMode = "monologue" | "conversation";

export interface RoastSentence {
  text: string;
  motion: MotionState;
  intensity: number;
}

interface SessionState {
  phase: SessionPhase;
  sessionMode: SessionMode;
  burnIntensity: BurnIntensity;
  contentMode: ContentMode;
  activePersona: PersonaId;
  isSpeaking: boolean;
  isListening: boolean;
  isUserSpeaking: boolean;
  transcript: string;
  audioAmplitude: number; // 0-1 RMS from AnalyserNode
  activeMotionState: MotionState;
  motionIntensity: number; // 0-1
  lastSceneJson: string | null;
  recordedBlob: Blob | null;
  error: string | null;
  timingLog: string[];
  observations: string[];
  visionSetting: string | null; // best guess at user's location from background analysis
  conversationEvents: ConversationEvent[];
  timeToFirstSpeechMs: number | null;
  hasSpokenThisSession: boolean;
  lastVisionCallTs: number | null;

  // Comedian Brain state (conversation mode)
  brainState: BrainState | null;
  currentQuestion: string | null;
  userAnswer: string;
  isUserLaughing: boolean; // vision-based: set when observations contain laugh keywords

  // Transcript history for debug panel
  transcriptHistory: { role: "user" | "puppet"; text: string; ts: number }[];

  // Session timer — set when phase enters "roasting"
  sessionStartTs: number | null;
  setSessionStartTs: (ts: number | null) => void;

  // Debug: type a response instead of speaking (consumed by LiveSessionController)
  pendingDebugTranscription: string | null;
  submitDebugTranscription: (text: string) => void;
  clearPendingDebugTranscription: () => void;

  // actions
  setPhase: (phase: SessionPhase, trigger: SessionTrigger) => void;
  setSessionMode: (mode: SessionMode) => void;
  setBurnIntensity: (intensity: BurnIntensity) => void;
  setContentMode: (mode: ContentMode) => void;
  setActivePersona: (persona: PersonaId) => void;
  setIsSpeaking: (speaking: boolean) => void;
  setIsListening: (listening: boolean) => void;
  setIsUserSpeaking: (speaking: boolean) => void;
  setTranscript: (text: string) => void;
  setAudioAmplitude: (amplitude: number) => void;
  setActiveMotionState: (state: MotionState, intensity: number) => void;
  setLastSceneJson: (json: string) => void;
  setRecordedBlob: (blob: Blob) => void;
  setError: (error: string | null) => void;
  logTiming: (entry: string) => void;
  clearTimingLog: () => void;
  setObservations: (obs: string[]) => void;
  setVisionSetting: (setting: string | null) => void;
  addConversationEvent: (type: ConversationEvent["type"], text?: string) => void;
  clearConversationEvents: () => void;
  setTimeToFirstSpeechMs: (ms: number | null) => void;
  setHasSpokenThisSession: (spoken: boolean) => void;
  setLastVisionCallTs: (ts: number | null) => void;
  setBrainState: (state: BrainState | null) => void;
  setCurrentQuestion: (q: string | null) => void;
  setUserAnswer: (ans: string) => void;
  setIsUserLaughing: (laughing: boolean) => void;
  pushTranscriptEntry: (role: "user" | "puppet", text: string) => void;
  timelineSpans: TimelineSpan[];
  beginSpan: (row: TimelineRow, label: string, color?: string) => string;
  endSpan: (id: string) => void;
  clearTimelineSpans: () => void;
  clearTranscriptHistory: () => void;
  reset: () => void;
}

const initialState = {
  phase: "idle" as SessionPhase,
  sessionMode: "conversation" as SessionMode,
  burnIntensity: 5 as BurnIntensity,
  contentMode: "clean" as ContentMode,
  activePersona: DEFAULT_PERSONA,
  isSpeaking: false,
  isListening: false,
  isUserSpeaking: false,
  transcript: "",
  audioAmplitude: 0,
  activeMotionState: "idle" as MotionState,
  motionIntensity: 0.3,
  lastSceneJson: null,
  recordedBlob: null,
  error: null,
  timingLog: [] as string[],
  observations: [] as string[],
  visionSetting: null as string | null,
  conversationEvents: [] as ConversationEvent[],
  timeToFirstSpeechMs: null as number | null,
  hasSpokenThisSession: false,
  lastVisionCallTs: null as number | null,
  brainState: null as BrainState | null,
  currentQuestion: null as string | null,
  userAnswer: "",
  isUserLaughing: false,
  transcriptHistory: [] as { role: "user" | "puppet"; text: string; ts: number }[],
  timelineSpans: [] as TimelineSpan[],
  sessionStartTs: null as number | null,
  pendingDebugTranscription: null as string | null,
};

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,

  setPhase: (phase, trigger) => {
    const current = useSessionStore.getState().phase;
    const event = transition(current, phase, SESSION_TRANSITIONS, trigger);
    if (!event) return;
    set({ phase });
  },
  setSessionMode: (sessionMode) => set({ sessionMode }),
  setBurnIntensity: (burnIntensity) => set({ burnIntensity }),
  setContentMode: (contentMode) => set({ contentMode }),
  setActivePersona: (activePersona) => set({ activePersona }),
  setIsSpeaking: (isSpeaking) => set({ isSpeaking }),
  setIsListening: (isListening) => set({ isListening }),
  setIsUserSpeaking: (isUserSpeaking) => set({ isUserSpeaking }),
  setTranscript: (transcript) => set({ transcript }),
  setAudioAmplitude: (audioAmplitude) => set({ audioAmplitude }),
  setActiveMotionState: (activeMotionState, motionIntensity) =>
    set({ activeMotionState, motionIntensity }),
  setLastSceneJson: (lastSceneJson) => set({ lastSceneJson }),
  setRecordedBlob: (recordedBlob) => set({ recordedBlob }),
  setError: (error) => set({ error }),
  logTiming: (entry) =>
    set((s) => {
      const rel = s.sessionStartTs !== null
        ? `+${((Date.now() - s.sessionStartTs) / 1000).toFixed(2)}s`
        : "--";
      const line = `${rel} ${entry}`;
      const next = [...s.timingLog.slice(-499), line];
      try { localStorage.setItem("roastie-timing-log", JSON.stringify(next)); } catch { /* ignore */ }
      return { timingLog: next };
    }),
  clearTimingLog: () => set({ timingLog: [] }),
  setObservations: (observations) => set({ observations }),
  setVisionSetting: (visionSetting) => set({ visionSetting }),
  addConversationEvent: (type, text) =>
    set((s) => ({
      conversationEvents: [
        ...s.conversationEvents.slice(-29),
        { type, text, ts: Date.now() },
      ],
    })),
  clearConversationEvents: () => set({ conversationEvents: [] }),
  setTimeToFirstSpeechMs: (timeToFirstSpeechMs) => set({ timeToFirstSpeechMs }),
  setHasSpokenThisSession: (hasSpokenThisSession) => set({ hasSpokenThisSession }),
  setLastVisionCallTs: (lastVisionCallTs) => set({ lastVisionCallTs }),
  setBrainState: (brainState) => set({ brainState }),
  setCurrentQuestion: (currentQuestion) => set({ currentQuestion }),
  setUserAnswer: (userAnswer) => set({ userAnswer }),
  setIsUserLaughing: (isUserLaughing) => set({ isUserLaughing }),
  pushTranscriptEntry: (role, text) =>
    set((s) => {
      const next = [...s.transcriptHistory.slice(-199), { role, text, ts: Date.now() }];
      try { localStorage.setItem("roastie-transcript", JSON.stringify(next)); } catch { /* ignore */ }
      return { transcriptHistory: next };
    }),
  beginSpan: (row, label, color) => {
    const id = `${row}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      timelineSpans: [
        ...s.timelineSpans.slice(-299),
        { id, row, label, startTs: Date.now(), endTs: null, color: color ?? TIMELINE_ROW_COLORS[row] },
      ],
    }));
    return id;
  },
  endSpan: (id) =>
    set((s) => ({
      timelineSpans: s.timelineSpans.map((span) =>
        span.id === id ? { ...span, endTs: Date.now() } : span
      ),
    })),
  clearTimelineSpans: () => set({ timelineSpans: [] }),
  clearTranscriptHistory: () => set({ transcriptHistory: [] }),
  setSessionStartTs: (sessionStartTs) => set({ sessionStartTs }),
  submitDebugTranscription: (text) => set({ pendingDebugTranscription: text }),
  clearPendingDebugTranscription: () => set({ pendingDebugTranscription: null }),
  reset: () => set(initialState),
}));
