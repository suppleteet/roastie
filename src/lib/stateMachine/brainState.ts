import type { TransitionMap } from "./types";

export type BrainState =
  | "greeting"
  | "vision_jokes"
  | "ask_question"
  | "wait_answer"
  | "prodding"
  | "pre_generate"
  | "generating"
  | "delivering"
  | "redirecting"
  | "check_vision"
  | "vision_react";

export type MicMode = "off" | "listening" | "passive";

export type BrainTrigger =
  | "STARTED"
  | "TTS_DRAINED"
  | "VISION_READY"
  | "NO_CAMERA"
  | "VISION_JOKES_DONE"
  | "QUESTION_ASKED"
  | "VISION_ONLY_MODE"
  | "USER_SPOKE"
  | "SILENCE_TIMEOUT"
  | "VAD_SPEECH_END"
  | "SPECULATIVE_THRESHOLD"
  | "PROD_EXHAUSTED"
  | "FIRST_JOKE_STREAMED"
  | "JOKES_RECEIVED"
  | "ANSWER_IRRELEVANT"
  | "DELIVERY_DRAINED"
  | "FOLLOW_UP"
  | "REDIRECT_DRAINED"
  | "VISION_INTERESTING"
  | "VISION_BORING"
  | "VISION_REACT_DONE"
  | "MIC_UNAVAILABLE";

export const BRAIN_TRANSITIONS: TransitionMap<BrainState> = {
  greeting:      ["vision_jokes", "ask_question"],
  vision_jokes:  ["ask_question"],
  ask_question:  ["wait_answer", "check_vision"],
  wait_answer:   ["pre_generate", "prodding", "generating", "check_vision"],
  prodding:      ["wait_answer", "check_vision"],
  pre_generate:  ["generating", "prodding", "check_vision"],
  generating:    ["delivering", "redirecting"],
  delivering:    ["check_vision", "ask_question"],
  redirecting:   ["wait_answer"],
  check_vision:  ["vision_react", "ask_question"],
  vision_react:  ["ask_question"],
};

export interface BrainStateConfig {
  micMode: MicMode;
  canSkipTo: BrainState | null;
}

export const BRAIN_STATE_CONFIG: Record<BrainState, BrainStateConfig> = {
  greeting:      { micMode: "off",       canSkipTo: "ask_question" },
  vision_jokes:  { micMode: "off",       canSkipTo: "ask_question" },
  ask_question:  { micMode: "passive",   canSkipTo: null },
  wait_answer:   { micMode: "listening", canSkipTo: "check_vision" },
  prodding:      { micMode: "listening", canSkipTo: "check_vision" },
  pre_generate:  { micMode: "listening", canSkipTo: null },
  generating:    { micMode: "passive",   canSkipTo: null },
  delivering:    { micMode: "passive",   canSkipTo: null },
  redirecting:   { micMode: "passive",   canSkipTo: null },
  check_vision:  { micMode: "passive",   canSkipTo: null },
  vision_react:  { micMode: "passive",   canSkipTo: null },
};
