/**
 * Heuristic confidence scoring for Gemini Live transcriptions.
 *
 * Gemini Live API provides no confidence scores — only { text, finished }.
 * This module estimates how likely a transcription is correct based on
 * surface-level signals: length, content, filler words, etc.
 *
 * Returns 0-1 where:
 *   0.0 = garbage (punctuation only, empty)
 *   0.3 = very suspicious (filler words, repeated syllables)
 *   0.7 = reasonable baseline
 *   1.0 = high confidence (clean, expected-length answer)
 */

const PUNCT_ONLY_RE = /^[\s.,!?;:\-"'()\[\]…]+$/;
const FILLER_WORDS = new Set([
  "um", "uh", "hmm", "hm", "mm", "er", "ah", "oh", "like",
  "so", "well", "okay", "ok", "right", "yeah", "yep", "nah",
  "mhm", "uh-huh", "uhh", "umm", "ehh",
]);
const REPEATED_SYLLABLE_RE = /^(\S+)(\s+\1){2,}$/i;
/** Patterns that introduce a name — the answer is structured, not garbled. */
const NAME_INTRO_RE = /^(my name is|i'm|im|it's|its|call me|they call me|i am|the name's|name's)\s+/i;

/**
 * Score how confident we are that `answer` is a real transcription
 * of what the user said in response to the given question.
 */
export function transcriptConfidence(
  answer: string,
  questionId: string,
): number {
  const trimmed = answer.trim();

  // Empty or whitespace
  if (!trimmed) return 0.0;

  // Punctuation / symbols only (Gemini sometimes returns "..." or "?")
  if (PUNCT_ONLY_RE.test(trimmed)) return 0.0;

  // Single character
  if (trimmed.length === 1) return 0.1;

  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Start with a reasonable baseline
  let score = 0.7;

  // All filler words — not a real answer
  const allFiller = words.every((w) => FILLER_WORDS.has(w.toLowerCase()));
  if (allFiller) score -= 0.4;

  // Repeated syllable pattern ("ba ba ba", "the the the")
  if (REPEATED_SYLLABLE_RE.test(trimmed)) score -= 0.3;

  // Question-specific expectations
  if (questionId === "name") {
    // Names are typically 1-3 words. Very short single-word fillers are suspect.
    if (wordCount === 1 && FILLER_WORDS.has(words[0].toLowerCase())) {
      score -= 0.3; // "um" as a name is almost certainly wrong
    }
    // "My name is X" or "I'm X" — structured answer, high confidence
    if (NAME_INTRO_RE.test(trimmed)) {
      score += 0.2;
    } else if (wordCount > 4) {
      // Too many words without an intro phrase is suspicious
      score -= 0.15;
    }
    // Single word that looks like a real name (capitalized, 2+ chars) is a good sign
    if (wordCount <= 3 && words.every((w) => /^[A-Z]/.test(w) && w.length >= 2)) {
      score += 0.15;
    }
  }

  // Very short answer (2 chars total) for any question
  if (trimmed.length <= 2 && questionId !== "age") score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

/** Default thresholds — question-specific overrides live in questionBank.ts */
export const CONFIDENCE_THRESHOLDS = {
  /** Below this: reject outright, ask again */
  reject: 0.3,
  /** Default confirm threshold (overridden per-question) */
  defaultConfirm: 0.6,
} as const;
