import { NextRequest, NextResponse } from "next/server";
import { createSession, deleteSession } from "@/lib/chatSessionStore";
import { PERSONA_IDS, DEFAULT_PERSONA, type PersonaId } from "@/lib/personas";
import type { BurnIntensity } from "@/lib/prompts";

/**
 * POST /api/comedian-session — Create a new multi-turn chat session.
 * Returns { sessionId } to be passed on subsequent joke requests.
 *
 * DELETE /api/comedian-session — End a session (cleanup).
 * Body: { sessionId }
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }

  let body: { persona?: string; burnIntensity?: number; contentMode?: string; model?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const persona: PersonaId = PERSONA_IDS.includes(body.persona as PersonaId)
    ? (body.persona as PersonaId)
    : DEFAULT_PERSONA;
  const burnIntensity: BurnIntensity = ([1, 2, 3, 4, 5] as const).includes(
    body.burnIntensity as BurnIntensity,
  )
    ? (body.burnIntensity as BurnIntensity)
    : 3;
  const contentMode = body.contentMode === "vulgar" ? "vulgar" : "clean";

  const sessionId = createSession(apiKey, persona, burnIntensity, contentMode, body.model);

  return NextResponse.json({ sessionId });
}

export async function DELETE(req: NextRequest) {
  let body: { sessionId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.sessionId) {
    deleteSession(body.sessionId);
  }

  return NextResponse.json({ ok: true });
}
