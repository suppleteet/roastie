/**
 * Server-side in-memory store for multi-turn chat sessions.
 *
 * Supports all LLM providers:
 *   - Gemini: native Chat object (SDK manages history internally)
 *   - OpenAI / Anthropic: explicit message history replayed each request
 *
 * Each session holds the full comedian persona as the system prompt.
 * Subsequent joke requests send only the small per-turn context — the persona
 * is already baked into the session.
 *
 * Sessions auto-expire after TTL_MS. If the server restarts, all sessions are
 * lost — callers should fall back to stateless generation transparently.
 */

import { GoogleGenAI, type Chat } from "@google/genai";
import { ROAST_MODEL } from "@/lib/constants";
import { getBaseJokePrompt } from "@/lib/prompts";
import type { BurnIntensity } from "@/lib/prompts";
import type { PersonaId } from "@/lib/personas";
import type { JokeContext } from "@/app/api/generate-joke/route";
import { generateText, generateTextStream, type UserPart } from "@/lib/llmClient";
import {
  estimateTokenCount,
  estimateUserPartsTokens,
  recordLlmUsage,
} from "@/lib/usageTracker";

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // check every minute

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface SessionEntry {
  model: string;
  systemPrompt: string;
  /** Gemini only — native Chat object that manages its own history. */
  geminiChat?: Chat;
  /** Non-Gemini — explicit message history for replay. */
  history: HistoryEntry[];
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

function isGemini(model: string): boolean {
  return !model.startsWith("gpt-") && !model.startsWith("claude-") && !model.startsWith("o1") && !model.startsWith("o3");
}

/**
 * Create a new chat session with the comedian persona baked in.
 */
export function createSession(
  apiKey: string,
  persona: PersonaId,
  burnIntensity: BurnIntensity,
  contentMode: "clean" | "vulgar",
  model?: string,
): string {
  const resolvedModel = model ?? ROAST_MODEL;
  // Base persona only — NO context-specific task instructions.
  // Per-turn context instructions come via getContextInstructions() in each user message.
  const systemPrompt = getBaseJokePrompt(persona, burnIntensity, contentMode);

  let geminiChat: Chat | undefined;

  if (isGemini(resolvedModel)) {
    const ai = new GoogleGenAI({ apiKey });
    geminiChat = ai.chats.create({
      model: resolvedModel,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 200,
      },
    });
  }

  const id = generateId();
  const now = Date.now();
  sessions.set(id, {
    model: resolvedModel,
    systemPrompt,
    geminiChat,
    history: [],
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
 * Send a message in a multi-turn session. Returns the model's response text.
 *
 * - Gemini: uses native Chat.sendMessage() (history managed internally)
 * - Others: replays history + new message via generateText(), then appends to history
 */
export async function sendMessage(
  sessionId: string,
  userParts: UserPart[],
  maxOutputTokens?: number,
): Promise<string | null> {
  const session = getSession(sessionId);
  if (!session) return null;

  // Extract text from userParts for history storage
  const userText = userParts.map((p) => ("text" in p ? p.text : "[image]")).join("\n");

  if (session.geminiChat) {
    const result = await session.geminiChat.sendMessage({ message: userParts });
    const text = result.text ?? "";
    const usage = result.usageMetadata;
    recordLlmUsage({
      route: "chatSession",
      provider: "gemini",
      model: session.model,
      inputTokens: usage?.promptTokenCount ?? estimateUserPartsTokens(userParts),
      outputTokens: usage?.candidatesTokenCount ?? estimateTokenCount(text),
      exact: Boolean(usage?.totalTokenCount),
    });
    // Gemini manages its own history, but we still track for debugging
    session.history.push({ role: "user", content: userText });
    session.history.push({ role: "assistant", content: text });
    return text;
  }

  // Non-Gemini: build full message list with history
  const historyText = session.history
    .map((h) => `[${h.role === "user" ? "USER" : "ASSISTANT"}]: ${h.content}`)
    .join("\n\n");

  const contextParts: UserPart[] = [];
  if (historyText) {
    contextParts.push({ text: `CONVERSATION HISTORY:\n${historyText}\n\n---\nNEW REQUEST:\n` });
  }
  contextParts.push(...userParts);

  const text = await generateText({
    model: session.model,
    systemPrompt: session.systemPrompt,
    userParts: contextParts,
    maxOutputTokens,
    forceJsonObject: true,
  });

  session.history.push({ role: "user", content: userText });
  session.history.push({ role: "assistant", content: text });
  return text;
}

/**
 * Streaming version of sendMessage. Returns an async iterable of text chunks.
 *
 * - Gemini: uses native Chat.sendMessageStream()
 * - Others: replays history via generateTextStream(), accumulates for history
 */
export async function* sendMessageStream(
  sessionId: string,
  userParts: UserPart[],
): AsyncGenerator<string> {
  const session = getSession(sessionId);
  if (!session) return;

  const userText = userParts.map((p) => ("text" in p ? p.text : "[image]")).join("\n");

  if (session.geminiChat) {
    const stream = await session.geminiChat.sendMessageStream({ message: userParts });
    let accumulated = "";
    let promptTokenCount: number | undefined;
    let candidatesTokenCount: number | undefined;
    let totalTokenCount: number | undefined;
    for await (const chunk of stream) {
      if (chunk.usageMetadata) {
        promptTokenCount = chunk.usageMetadata.promptTokenCount;
        candidatesTokenCount = chunk.usageMetadata.candidatesTokenCount;
        totalTokenCount = chunk.usageMetadata.totalTokenCount;
      }
      const text = chunk.text ?? "";
      if (text) {
        accumulated += text;
        yield text;
      }
    }
    recordLlmUsage({
      route: "chatSessionStream",
      provider: "gemini",
      model: session.model,
      inputTokens: promptTokenCount ?? estimateUserPartsTokens(userParts),
      outputTokens: candidatesTokenCount ?? estimateTokenCount(accumulated),
      exact: Boolean(totalTokenCount),
    });
    session.history.push({ role: "user", content: userText });
    session.history.push({ role: "assistant", content: accumulated });
    return;
  }

  // Non-Gemini: replay history
  const historyText = session.history
    .map((h) => `[${h.role === "user" ? "USER" : "ASSISTANT"}]: ${h.content}`)
    .join("\n\n");

  const contextParts: UserPart[] = [];
  if (historyText) {
    contextParts.push({ text: `CONVERSATION HISTORY:\n${historyText}\n\n---\nNEW REQUEST:\n` });
  }
  contextParts.push(...userParts);

  let accumulated = "";
  for await (const chunk of generateTextStream({
    model: session.model,
    systemPrompt: session.systemPrompt,
    userParts: contextParts,
    forceJsonObject: true,
  })) {
    accumulated += chunk;
    yield chunk;
  }

  session.history.push({ role: "user", content: userText });
  session.history.push({ role: "assistant", content: accumulated });
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
export function getContextInstructions(
  context: JokeContext,
  contentMode: "clean" | "vulgar" = "clean",
): string {
  // These are the task-specific parts from prompts.ts contextInstructions,
  // but without the persona/character setup (that's in the chat systemInstruction).
  const wrapupVulgarSuffix = contentMode === "vulgar"
    ? `\n\nVULGAR MODE: close with one last GENERAL gut-punch insult as part of the goodbye — crude, dismissive (e.g. "I gotta go, you sad piece of shit," "fuck off, [name]"). Tie to their specifics, but the farewell itself can be blunt and profane.`
    : "";

  const instructions: Record<JokeContext, string> = {
    greeting: `TASK: Opening greeting + first visual reaction. React to what you SEE.
Keep it tight: quick opener + ONE comprehensive roast line that combines multiple observed traits
(appearance + vibe + inferred setting) into one coherent burn.
Use at least 3 concrete observations when available.
Set "relevant": true. No "followUp". Generate exactly 1 joke.`,

    vision_opening: `TASK: First vision joke. 1 sharp opening observation about what you see.
Max 20 words, punchline at the end. Set "relevant": true. Generate exactly 1 joke.`,

    answer_roast: `TASK: Roast the user's answer. 1-2 jokes that directly reference and roast their answer.
Max 20 words per sentence, punchline at the end. Each sentence self-contained.
If FILLER_ALREADY_SAID is provided, that exact line was just spoken aloud — do NOT open with the same sound or phrasing.
If FILLER_ALREADY_SAID ends in a question mark (e.g. "Tyler?", "So — Seattle?", "a dentist, huh?"), it already echoed the user's answer back as a question. Do NOT open your joke by re-asking or re-stating the answer ("Tyler? Really?", "So a dentist?") — go straight into the punchline.
If off-topic, set "relevant": false with a witty "redirect".

FOLLOW-UP RULE (be strict — the default is to OMIT followUp):
Only emit "followUp" when ALL of these are true:
  1. The user gave a SPECIFIC answer (proper noun, named place, real detail) — not a generic / one-word / yes-no.
  2. There is an obviously juicy roast angle in their answer that the jokes you wrote did NOT already cover.
  3. The follow-up is ONE open question that any normal person can answer in a sentence.
  4. The follow-up is NOT "A or B" / "X or Y" / multiple-choice / closed yes-no.
  5. The follow-up unlocks a new dimension to roast — it does NOT just rephrase the same topic ("so what kind of teacher?", "so what hobby?").
When in doubt: omit followUp. The host will change topics — that's a feature, not a bug.

PIPELINE RULE: If JOKES ALREADY DELIVERED THIS CYCLE is provided, those jokes have ALREADY played aloud.
Do NOT re-introduce the answer, echo the user's words, or open as if hearing the answer for the first time.
Do NOT start with "[answer]? [joke]" or "So your [answer]..." — that opener was already used.
Each successive joke must feel like the NEXT beat in a tight comedy SET — escalate, pivot to a new angle, or riff off the previous joke. Build momentum, don't restart.

Generate 1-2 jokes.`,

    vision_react: `TASK: React to a visual change on camera. Something just changed — react like you just noticed.
1 sharp reactive joke. Max 20 words. Set "relevant": true. Generate 1 joke.`,

    hopper: `TASK: Background joke generation. 2-3 candidate jokes for later use.
Max 20 words each, punchline at the end, one sentence only.
Score each honestly (8+ = "would interrupt the show"). Generate 2-3 jokes.`,

    wrapup: `TASK: CLOSING SIGN-OFF — clever goodbye wrapped in one last roast. The show is ending and you're leaving the stage.
Use KNOWN FACTS (name + a couple specifics they revealed) so the farewell is personal.
The line MUST include a goodbye delivered IN CHARACTER — never break the fourth wall with "thanks for watching" or meta references to "the show."
Max 30 words, punchline at the end. No question, no follow-up.${wrapupVulgarSuffix}
Set "relevant": true. Generate exactly 1 joke.`,
  };

  return instructions[context];
}
