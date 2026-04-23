import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, readdir, unlink } from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { VISION_MODEL } from "@/lib/constants";

export const dynamic = "force-dynamic";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const NOTES_DIR = path.join(process.cwd(), ".debug", "voice-notes");
const MAX_NOTES = 50;
const MAX_BODY = 10_000_000; // 10 MB

export async function POST(req: NextRequest) {
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;
    const context = (formData.get("context") as string) ?? "unknown";
    const noteIndex = (formData.get("index") as string) ?? "0";
    const sessionTs = (formData.get("sessionTs") as string) ?? "0";
    const sessionLog = (formData.get("sessionLog") as string) ?? null;

    if (!audioFile || audioFile.size === 0) {
      return NextResponse.json({ error: "No audio provided" }, { status: 400 });
    }

    // Transcribe audio via Gemini
    const audioBuffer = await audioFile.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString("base64");
    const mimeType = audioFile.type || "audio/webm";

    let transcript = "";
    try {
      const response = await ai.models.generateContent({
        model: VISION_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: audioBase64 } },
              { text: "Transcribe this audio exactly as spoken. Return ONLY the transcription text, nothing else." },
            ],
          },
        ],
        config: { maxOutputTokens: 2000 },
      });
      transcript = (response.text ?? "").trim();
    } catch (e) {
      console.error("[save-voice-note] transcription failed:", e);
      transcript = "[transcription failed]";
    }

    // Save as JSON with transcript + session log
    await mkdir(NOTES_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `note-${noteIndex}-${ts}.json`;

    const note: Record<string, unknown> = {
      transcript,
      context,
      noteIndex: Number(noteIndex),
      sessionTs: Number(sessionTs),
      recordedAt: new Date().toISOString(),
      audioSizeBytes: audioBuffer.byteLength,
    };

    // Include session log if provided
    if (sessionLog) {
      try {
        note.sessionLog = JSON.parse(sessionLog);
      } catch {
        note.sessionLog = sessionLog;
      }
    }

    await writeFile(
      path.join(NOTES_DIR, filename),
      JSON.stringify(note, null, 2),
      "utf-8",
    );

    // Prune old notes
    const files = (await readdir(NOTES_DIR))
      .filter((f) => f.startsWith("note-") && f.endsWith(".json"))
      .sort();
    if (files.length > MAX_NOTES) {
      for (const old of files.slice(0, files.length - MAX_NOTES)) {
        await unlink(path.join(NOTES_DIR, old)).catch(() => {});
      }
    }

    console.log(`[save-voice-note] "${transcript.slice(0, 80)}" → ${filename}`);
    return NextResponse.json({ ok: true, transcript, filename, folder: NOTES_DIR });
  } catch (err) {
    console.error("[save-voice-note]", err);
    return NextResponse.json({ error: "Failed to save voice note" }, { status: 500 });
  }
}
