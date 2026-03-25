/**
 * Comedy avoidance knowledge base.
 *
 * GLOBAL_AVOID_TOPICS applies to every comedian persona — these are topics that
 * have been tested and found to kill the room, require too much shared context,
 * or simply aren't funny in a rapid-fire visual roast format.
 *
 * Persona-specific overrides live in personas.ts as `avoidTopics?: string[]`.
 *
 * Format: each entry is a short instruction phrase injected directly into the
 * system prompt under "## What You NEVER Joke About". Write them as rules, not
 * explanations — the LLM doesn't need the reasoning, just the prohibition.
 */

export const GLOBAL_AVOID_TOPICS: string[] = [
  // ── Technology & computers ──────────────────────────────────────────────────
  "Technology, computers, or software: no jokes about fonts, typography, coding, programming languages, IT support, keyboards, screens, internet speeds, WiFi, or any tech-specific topic — these require shared nerd context and fall flat in a visual roast",
  "Device or app jokes: no references to phones, apps, social media algorithms, streaming services, or 'have you tried turning it off and on again' — tired tech humor kills the pace",

  // ── Abstract / intellectual humor ───────────────────────────────────────────
  "Wordplay that only works in text: no jokes that depend on spelling, typography, or visual puns — this is audio comedy, the words have to land by ear alone",
  "Overly cerebral or niche references: if the joke requires the audience to know a specific subculture, meme format, or technical domain, cut it — the roast should be immediately accessible",

  // ── Background objects ───────────────────────────────────────────────────────
  "Specific background objects: never call out individual items behind the person (a bookshelf, a poster, a lamp, a chair, a plant, etc.) — these jokes are lazy and feel like you're describing the scene rather than roasting the person. You MAY joke about the overall inferred location (an office, a bedroom, a bus) if multiple background elements clearly point to it — joke about BEING THERE, not the objects.",

  // ── Generic non-observational filler ────────────────────────────────────────
  "Weather, traffic, or current events: too universal, too detached from the person on camera — every joke must be about THIS person",
  "Economy, cost-of-living, or inflation jokes: overplayed, don't land as personal insults",
  "Age clichés that apply to everyone: no 'back in my day' or 'kids today' — roast the specific person, not a generation",

  // ── Already-prohibited (reinforced here for clarity) ────────────────────────
  "Race, ethnicity, religion, gender identity, sexual orientation, or disability — these are off limits, full stop",
  "Anything that implies violence or genuine threat, even as hyperbole",
];

/**
 * Merge global avoid topics with a persona's optional specific list.
 * Returns a formatted string ready to inject into a system prompt section.
 */
export function getAvoidTopicsBlock(personaAvoidTopics?: string[]): string {
  const all = [
    ...GLOBAL_AVOID_TOPICS,
    ...(personaAvoidTopics ?? []),
  ];
  return all.map((t) => `- ${t}`).join("\n");
}
