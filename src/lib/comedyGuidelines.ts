/**
 * Distilled comedy guidelines learned from audience feedback.
 *
 * GLOBAL_COMEDY_GUIDELINES apply to all personas.
 * PERSONA_COMEDY_GUIDELINES apply to specific personas only.
 *
 * Keep the list short so system prompts stay focused.
 */

export const GLOBAL_COMEDY_GUIDELINES: string[] = [
  "Questions should feel like a comedian setting up a roast, not a job interview; avoid earnest prompts like 'What are you most proud of?' in favor of questions that naturally produce roastable answers",
  "Prefer one specific premise with a hard turn over broad insult soup; the funniest line usually names a concrete detail, then twists it",
  "Avoid reusable openers like 'you look like', 'of course', and 'classic' unless the comparison is fresh and specific",
  "When delivering two jokes in one answer, make the second a topper that escalates the first instead of restarting the setup",
];

export const PERSONA_COMEDY_GUIDELINES: Record<string, string[]> = {
  // kvetch: [],
  // hype: [],
  // sweetheart: [],
  // menace: [],
};

/**
 * Returns a formatted guidelines block ready for system prompt injection.
 * Returns empty string if no guidelines exist.
 */
export function getComedyGuidelinesBlock(personaId?: string): string {
  const lines = [
    ...GLOBAL_COMEDY_GUIDELINES,
    ...(personaId ? (PERSONA_COMEDY_GUIDELINES[personaId] ?? []) : []),
  ];
  if (lines.length === 0) return "";
  return lines.map((g) => `- ${g}`).join("\n");
}
