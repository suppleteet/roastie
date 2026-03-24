/**
 * Declarative state machine configuration for ComedianBrain.
 *
 * To add/remove/reorder states: edit STATE_CONFIG and implement the
 * corresponding enter method on ComedianBrain. No other wiring needed.
 */

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

export interface StateDefinition {
  /** Default next state after TTS drains (can be overridden by brain logic) */
  next: BrainState;
  /** Microphone routing for this state */
  micMode: MicMode;
  /** State to jump to when skipping (e.g. silence timeout) — null = not skippable */
  canSkipTo: BrainState | null;
}

export const STATE_CONFIG: Record<BrainState, StateDefinition> = {
  greeting:     { next: "vision_jokes",  micMode: "off",       canSkipTo: "ask_question" },
  vision_jokes: { next: "ask_question",  micMode: "off",       canSkipTo: "ask_question" },
  ask_question: { next: "wait_answer",   micMode: "passive",   canSkipTo: null },
  wait_answer:  { next: "generating",    micMode: "listening", canSkipTo: "check_vision" },
  prodding:     { next: "wait_answer",   micMode: "listening", canSkipTo: "check_vision" },
  pre_generate: { next: "generating",    micMode: "listening", canSkipTo: null },
  generating:   { next: "delivering",    micMode: "passive",   canSkipTo: null },
  delivering:   { next: "check_vision",  micMode: "passive",   canSkipTo: null },
  redirecting:  { next: "wait_answer",   micMode: "passive",   canSkipTo: null },
  check_vision: { next: "ask_question",  micMode: "passive",   canSkipTo: null },
  vision_react: { next: "ask_question",  micMode: "passive",   canSkipTo: null },
};
