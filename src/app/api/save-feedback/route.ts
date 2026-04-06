import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const dynamic = "force-dynamic";

const MAX_BODY = 2_000_000; // 2 MB

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const body = (await req.json()) as {
      text?: string;
      type?: "post-session" | "critique" | "joke-rating";
      persona?: string;
      lastJokeText?: string;
      videoFilename?: string | null;
      sessionLog?: unknown;
    };

    const text = (body.text ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "No feedback text" }, { status: 400 });
    }

    const feedbackType = body.type ?? "post-session";

    const entry: Record<string, unknown> = {
      type: feedbackType,
      text,
      persona: body.persona ?? null,
      createdAt: new Date().toISOString(),
    };

    if ((feedbackType === "critique" || feedbackType === "joke-rating") && body.lastJokeText) {
      entry.lastJokeText = body.lastJokeText;
    }
    if (body.videoFilename) {
      entry.videoFilename = body.videoFilename;
    }
    if (body.sessionLog) {
      entry.sessionLog = body.sessionLog;
    }

    // Persist to Vercel Blob (durable) + console log (ephemeral backup)
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = feedbackType === "critique" ? "critique"
      : feedbackType === "joke-rating" ? "joke-rating"
      : "feedback";
    const blobPath = `feedback/${prefix}-${ts}.json`;

    const blob = await put(blobPath, JSON.stringify(entry, null, 2), {
      contentType: "application/json",
      access: "public",
    });

    console.log(`[save-feedback] [${feedbackType}] saved to ${blob.url}`);
    return NextResponse.json({ ok: true, url: blob.url });
  } catch (err) {
    console.error("[save-feedback]", err);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
