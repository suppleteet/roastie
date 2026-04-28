/**
 * Re-export shim — types are now canonical in @/lib/stateMachine.
 * This file keeps the legacy STATE_CONFIG (with `next` field) for
 * comedianBrain.ts until it's migrated to use BRAIN_TRANSITIONS directly.
 */
export type { BrainState, MicMode } from "@/lib/stateMachine";
import type { BrainState, MicMode } from "@/lib/stateMachine";

export interface StateDefinition {
  next: BrainState;
  micMode: MicMode;
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
  dev_note:     { next: "check_vision",  micMode: "off",       canSkipTo: "check_vision" },
  confirm_answer: { next: "generating",  micMode: "listening", canSkipTo: "check_vision" },
  redirecting:  { next: "wait_answer",   micMode: "passive",   canSkipTo: null },
  check_vision: { next: "ask_question",  micMode: "passive",   canSkipTo: null },
  vision_react: { next: "ask_question",  micMode: "passive",   canSkipTo: null },
  wrapup:       { next: "wrapup",        micMode: "off",       canSkipTo: null },
};
