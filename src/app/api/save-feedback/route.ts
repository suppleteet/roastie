import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, readdir, unlink } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const FEEDBACK_DIR = path.join(process.cwd(), ".debug", "feedback");
const MAX_FEEDBACK = 100;
const MAX_BODY = 2_000_000; // 2 MB

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const body = (await req.json()) as {
      text?: string;
      videoFilename?: string | null;
      sessionLog?: unknown;
    };

    const text = (body.text ?? "").trim();
    if (!text) {
      return NextResponse.json({ error: "No feedback text" }, { status: 400 });
    }

    await mkdir(FEEDBACK_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `feedback-${ts}.json`;

    const entry = {
      text,
      videoFilename: body.videoFilename ?? null,
      sessionLog: body.sessionLog ?? null,
      createdAt: new Date().toISOString(),
    };

    await writeFile(
      path.join(FEEDBACK_DIR, filename),
      JSON.stringify(entry, null, 2),
      "utf-8",
    );

    // Prune old feedback
    const files = (await readdir(FEEDBACK_DIR))
      .filter((f) => f.startsWith("feedback-") && f.endsWith(".json"))
      .sort();
    if (files.length > MAX_FEEDBACK) {
      for (const old of files.slice(0, files.length - MAX_FEEDBACK)) {
        await unlink(path.join(FEEDBACK_DIR, old)).catch(() => {});
      }
    }

    console.log(`[save-feedback] "${text.slice(0, 80)}" → ${filename}`);
    return NextResponse.json({ ok: true, filename });
  } catch (err) {
    console.error("[save-feedback]", err);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
