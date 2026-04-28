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
  | "dev_note"
  | "redirecting"
  | "confirm_answer"
  | "check_vision"
  | "vision_react"
  | "wrapup";

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
  | "MIC_UNAVAILABLE"
  | "ANSWER_CONFIRMED"
  | "ANSWER_REJECTED"
  | "DEV_NOTE_ENTER"
  | "DEV_NOTE_RESUME"
  | "WRAPUP_REQUESTED"
  | "WRAPUP_DRAINED";

export const BRAIN_TRANSITIONS: TransitionMap<BrainState> = {
  greeting:      ["vision_jokes", "ask_question", "wrapup"],
  vision_jokes:  ["ask_question", "wrapup"],
  ask_question:  ["wait_answer", "check_vision", "dev_note", "wrapup"],
  wait_answer:   ["pre_generate", "prodding", "generating", "confirm_answer", "ask_question", "check_vision", "dev_note", "wrapup"],
  prodding:      ["wait_answer", "check_vision", "wrapup"],
  pre_generate:  ["generating", "confirm_answer", "ask_question", "prodding", "check_vision", "wrapup"],
  generating:    ["delivering", "redirecting", "wrapup"],
  delivering:    ["check_vision", "ask_question", "dev_note", "wrapup"],
  dev_note:      ["check_vision", "ask_question", "wrapup"],
  confirm_answer: ["generating", "wait_answer", "ask_question", "check_vision", "wrapup"],
  redirecting:   ["wait_answer", "wrapup"],
  check_vision:  ["vision_react", "ask_question", "dev_note", "wrapup"],
  vision_react:  ["ask_question", "wrapup"],
  wrapup:        [],
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
  dev_note:      { micMode: "off",       canSkipTo: "check_vision" },
  confirm_answer: { micMode: "listening", canSkipTo: "check_vision" },
  redirecting:   { micMode: "passive",   canSkipTo: null },
  check_vision:  { micMode: "passive",   canSkipTo: null },
  vision_react:  { micMode: "passive",   canSkipTo: null },
  wrapup:        { micMode: "off",       canSkipTo: null },
};
