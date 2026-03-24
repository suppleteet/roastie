import { create } from "zustand";
import type { MotionState } from "@/lib/motionStates";
import type { BurnIntensity } from "@/lib/prompts";
import { DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { BrainState } from "@/lib/comedianBrainConfig";

export type ConversationEventType = "user-start" | "user-end" | "ai-speech" | "ai-done" | "interrupted" | "listening" | "rotate";

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

export type SessionPhase =
  | "idle"
  | "consent"
  | "requesting-permissions"
  | "roasting"
  | "stopped"
  | "sharing";

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
  conversationEvents: ConversationEvent[];
  timeToFirstSpeechMs: number | null;
  hasSpokenThisSession: boolean;
  lastVisionCallTs: number | null;

  // Comedian Brain state (conversation mode)
  brainState: BrainState | null;
  currentQuestion: string | null;
  userAnswer: string;

  // Transcript history for debug panel
  transcriptHistory: { role: "user" | "puppet"; text: string; ts: number }[];

  // actions
  setPhase: (phase: SessionPhase) => void;
  setSessionMode: (mode: SessionMode) => void;
  setBurnIntensity: (intensity: BurnIntensity) => void;
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
  addConversationEvent: (type: ConversationEvent["type"], text?: string) => void;
  clearConversationEvents: () => void;
  setTimeToFirstSpeechMs: (ms: number | null) => void;
  setHasSpokenThisSession: (spoken: boolean) => void;
  setLastVisionCallTs: (ts: number | null) => void;
  setBrainState: (state: BrainState | null) => void;
  setCurrentQuestion: (q: string | null) => void;
  setUserAnswer: (ans: string) => void;
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
  burnIntensity: 3 as BurnIntensity,
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
  conversationEvents: [] as ConversationEvent[],
  timeToFirstSpeechMs: null as number | null,
  hasSpokenThisSession: false,
  lastVisionCallTs: null as number | null,
  brainState: null as BrainState | null,
  currentQuestion: null as string | null,
  userAnswer: "",
  transcriptHistory: [] as { role: "user" | "puppet"; text: string; ts: number }[],
  timelineSpans: [] as TimelineSpan[],
};

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,

  setPhase: (phase) => set({ phase }),
  setSessionMode: (sessionMode) => set({ sessionMode }),
  setBurnIntensity: (burnIntensity) => set({ burnIntensity }),
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
    set((s) => ({ timingLog: [...s.timingLog.slice(-49), entry] })),
  clearTimingLog: () => set({ timingLog: [] }),
  setObservations: (observations) => set({ observations }),
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
  pushTranscriptEntry: (role, text) =>
    set((s) => ({
      transcriptHistory: [
        ...s.transcriptHistory.slice(-49),
        { role, text, ts: Date.now() },
      ],
    })),
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
  reset: () => set(initialState),
}));
