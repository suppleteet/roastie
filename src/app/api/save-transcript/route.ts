import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, readdir, unlink } from "fs/promises";
import path from "path";

const DEBUG_DIR = path.join(process.cwd(), ".debug");
const MAX_BODY_BYTES = 512_000; // 512KB limit

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const body = await req.json();

    await mkdir(DEBUG_DIR, { recursive: true });

    // Save as latest (always overwritten) + timestamped archive
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const latestPath = path.join(DEBUG_DIR, "last-transcript.json");
    const archivePath = path.join(DEBUG_DIR, `transcript-${ts}.json`);

    const content = JSON.stringify(body, null, 2);
    if (content.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    await Promise.all([
      writeFile(latestPath, content, "utf-8"),
      writeFile(archivePath, content, "utf-8"),
    ]);

    // Keep only last 10 archived transcripts
    const files = (await readdir(DEBUG_DIR))
      .filter((f) => f.startsWith("transcript-") && f.endsWith(".json"))
      .sort();
    if (files.length > 10) {
      for (const old of files.slice(0, files.length - 10)) {
        await unlink(path.join(DEBUG_DIR, old)).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[save-transcript]", err);
    return NextResponse.json(
      { error: "Failed to save transcript" },
      { status: 500 },
    );
  }
}
