import { NextRequest, NextResponse } from "next/server";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { VIDEOS_FOLDER } from "@/lib/videoPaths";
import { extensionForMimeType, type VideoExtension } from "@/lib/mediaRecorderSupport";

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 90_000;

const ADJECTIVES = [
  "charred", "scorched", "roasted", "singed", "crispy",
  "flaming", "toasted", "smoked", "sizzled", "burnt",
  "demolished", "obliterated", "eviscerated", "destroyed", "wrecked",
];
const NOUNS = [
  "noodle", "comedian", "victim", "survivor", "legend",
  "wreck", "disaster", "tragedy", "clown", "hero",
  "bystander", "casualty", "masterpiece", "disaster-zone", "relic",
];

function cleverBaseName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const ts = new Date()
    .toISOString()
    .replace("T", "-")
    .replace(/:/g, "")
    .slice(0, 17); // "2026-03-24-142301"
  return `${adj}-${noun}-${ts}`;
}

function convertToMp4(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Targeting universal sharing: iMessage, WhatsApp, Instagram, Android, iOS, Mac, Windows.
    // Settings match what iPhones produce: the de facto standard for mobile sharing.
    const proc = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-r", "30",
      "-c:v", "libx264",
      "-profile:v", "main",
      "-level", "3.1",
      "-bf", "0",             // no B-frames; some social/messaging apps choke on them
      "-preset", "fast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",         // widest audio compatibility
      "-movflags", "+faststart",
      "-brand", "mp42",
      outputPath,
    ]);

    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        const msg = timedOut
          ? `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`
          : `ffmpeg exited ${code}:\n${stderr.slice(-600)}`;
        console.error("[save-video]", msg);
        reject(new Error(msg));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.error("[save-video] spawn error:", err);
      reject(err);
    });
  });
}

export async function POST(req: NextRequest) {
  await mkdir(VIDEOS_FOLDER, { recursive: true });

  const arrayBuffer = await req.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return NextResponse.json({ error: "Empty blob" }, { status: 400 });
  }
  if (arrayBuffer.byteLength > MAX_VIDEO_BYTES) {
    return NextResponse.json({ error: "Video too large" }, { status: 413 });
  }

  const base = cleverBaseName();
  const inputType = req.headers.get("content-type") ?? "video/webm";
  const inputExt: VideoExtension = extensionForMimeType(inputType);
  const inputPath = join(VIDEOS_FOLDER, `${base}.${inputExt}`);
  const mp4Path = join(VIDEOS_FOLDER, `${base}.mp4`);

  await writeFile(inputPath, Buffer.from(arrayBuffer));
  console.log(`[save-video] wrote ${arrayBuffer.byteLength} bytes -> ${inputPath}`);

  if (inputExt === "mp4") {
    return NextResponse.json({
      filename: `${base}.mp4`,
      folder: VIDEOS_FOLDER,
      filePath: inputPath,
      mimeType: "video/mp4",
      sizeBytes: arrayBuffer.byteLength,
      converted: false,
    });
  }

  try {
    await convertToMp4(inputPath, mp4Path);
    await unlink(inputPath);
    console.log(`[save-video] converted -> ${mp4Path}`);
    return NextResponse.json({
      filename: `${base}.mp4`,
      folder: VIDEOS_FOLDER,
      filePath: mp4Path,
      mimeType: "video/mp4",
      sizeBytes: arrayBuffer.byteLength,
      converted: true,
    });
  } catch (err) {
    // Conversion failed; keep the original recording so the user still has something.
    return NextResponse.json(
      {
        filename: `${base}.${inputExt}`,
        folder: VIDEOS_FOLDER,
        filePath: inputPath,
        mimeType: inputType,
        sizeBytes: arrayBuffer.byteLength,
        conversionError: String(err),
      },
      { status: 200 },
    );
  }
}
