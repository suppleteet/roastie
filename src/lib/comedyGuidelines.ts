/**
 * Distilled comedy guidelines — learned from audience feedback.
 *
 * GLOBAL_COMEDY_GUIDELINES apply to all personas.
 * PERSONA_COMEDY_GUIDELINES apply to specific personas only.
 *
 * These are CUMULATIVE — each wrapup session refines them based on new
 * feedback from .debug/feedback/. Do not log specific jokes to avoid;
 * distill patterns and principles.
 *
 * Format: short instruction phrases, same style as avoidTopics.ts entries.
 * Keep the total count low (aim for 5-15 global + 0-5 per persona) to
 * avoid bloating system prompts.
 */

export const GLOBAL_COMEDY_GUIDELINES: string[] = [
  // Populated by wrapup distillation — initially empty
];

export const PERSONA_COMEDY_GUIDELINES: Record<string, string[]> = {
  // kvetch: [],
  // hype: [],
  // sweetheart: [],
  // menace: [],
};

/**
 * Returns a formatted guidelines block ready for system prompt injection.
 * Returns empty string if no guidelines exist (avoids empty sections in prompts).
 */
export function getComedyGuidelinesBlock(personaId?: string): string {
  const lines = [
    ...GLOBAL_COMEDY_GUIDELINES,
    ...(personaId ? (PERSONA_COMEDY_GUIDELINES[personaId] ?? []) : []),
  ];
  if (lines.length === 0) return "";
  return lines.map((g) => `- ${g}`).join("\n");
}
