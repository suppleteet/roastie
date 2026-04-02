/**
 * Server-side in-memory store for Gemini multi-turn chat sessions.
 *
 * Each session holds a GoogleGenAI Chat object created with the full comedian
 * persona as systemInstruction. Subsequent joke requests send only the small
 * per-turn context (question, answer, observations) — the persona is already
 * baked into the chat.
 *
 * Sessions auto-expire after TTL_MS. If the server restarts, all sessions are
 * lost — callers should fall back to stateless generation transparently.
 */

import { GoogleGenAI, type Chat } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { getJokePrompt } from "@/lib/prompts";
import type { BurnIntensity } from "@/lib/prompts";
import type { PersonaId } from "@/lib/personas";
import type { JokeContext } from "@/app/api/generate-joke/route";

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

interface SessionEntry {
  chat: Chat;
  createdAt: number;
  lastUsedAt: number;
  persona: PersonaId;
  burnIntensity: BurnIntensity;
  contentMode: "clean" | "vulgar";
}

const sessions = new Map<string, SessionEntry>();

// Lazy cleanup — runs periodically to evict expired sessions
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsedAt > TTL_MS) {
        sessions.delete(id);
      }
    }
    // Stop cleanup if no sessions left
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
}

function generateId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new chat session with the comedian persona baked in.
 * The context param determines the initial system prompt flavor.
 */
export function createSession(
  apiKey: string,
  persona: PersonaId,
  burnIntensity: BurnIntensity,
  contentMode: "clean" | "vulgar",
): string {
  const ai = new GoogleGenAI({ apiKey });

  // Use a generic context for the system instruction — the per-turn context
  // instructions will be prepended to each user message instead.
  const systemPrompt = getJokePrompt("answer_roast", persona, burnIntensity, contentMode);

  const chat = ai.chats.create({
    model: ROAST_MODEL,
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const id = generateId();
  const now = Date.now();
  sessions.set(id, {
    chat,
    createdAt: now,
    lastUsedAt: now,
    persona,
    burnIntensity,
    contentMode,
  });

  ensureCleanup();
  return id;
}

/**
 * Get a session by ID. Returns null if expired or not found.
 */
export function getSession(id: string): SessionEntry | null {
  const entry = sessions.get(id);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.lastUsedAt > TTL_MS) {
    sessions.delete(id);
    return null;
  }

  entry.lastUsedAt = now;
  return entry;
}

/**
 * Delete a session (e.g., on session end).
 */
export function deleteSession(id: string): void {
  sessions.delete(id);
}

/**
 * Build the per-turn context instructions for a specific joke context.
 * This replaces the full system prompt on each request — only the small
 * task-specific instructions are sent as part of the user message.
 */
export function getContextInstructions(context: JokeContext): string {
  // These are the task-specific parts from prompts.ts contextInstructions,
  // but without the persona/character setup (that's in the chat systemInstruction).
  const instructions: Record<JokeContext, string> = {
    greeting: `TASK: Opening greeting + first visual reaction. React to what you SEE.
2-3 sentences: drawn-out first reaction + 1-2 sharp observation jokes.
Set "relevant": true. No "followUp". Generate 2-3 jokes.`,

    vision_opening: `TASK: First vision joke. 1 sharp opening observation about what you see.
Max 20 words, punchline at the end. Set "relevant": true. Generate exactly 1 joke.`,

    answer_roast: `TASK: Roast the user's answer. 1-2 jokes that directly reference and roast their answer.
Max 20 words per sentence, punchline at the end. Each sentence self-contained.
If FILLER_ALREADY_SAID is provided, do NOT open with a similar filler sound.
If off-topic, set "relevant": false with a witty "redirect".
Include "followUp" if the answer invites one (open-ended, never A/B format).
Generate 1-2 jokes.`,

    vision_react: `TASK: React to a visual change on camera. Something just changed — react like you just noticed.
1 sharp reactive joke. Max 20 words. Set "relevant": true. Generate 1 joke.`,

    hopper: `TASK: Background joke generation. 2-3 candidate jokes for later use.
Max 20 words each, punchline at the end, one sentence only.
Score each honestly (8+ = "would interrupt the show"). Generate 2-3 jokes.`,
  };

  return instructions[context];
}
