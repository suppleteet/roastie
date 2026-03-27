import { NextRequest, NextResponse } from "next/server";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { VIDEOS_FOLDER } from "@/lib/videoPaths";

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
    // Use shell:true so Node finds ffmpeg via the same PATH as the terminal
    const proc = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-r", "30",
      "-c:v", "libx264",
      "-profile:v", "main",
      "-level", "3.1",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-brand", "mp42",       // WMP requires mp42 brand (rejects default isom)
      outputPath,
    ], { shell: true });

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = `ffmpeg exited ${code}:\n${stderr.slice(-600)}`;
        console.error("[save-video]", msg);
        reject(new Error(msg));
      }
    });
    proc.on("error", (err) => {
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

  const base = cleverBaseName();
  const webmPath = join(VIDEOS_FOLDER, `${base}.webm`);
  const mp4Path  = join(VIDEOS_FOLDER, `${base}.mp4`);

  await writeFile(webmPath, Buffer.from(arrayBuffer));
  console.log(`[save-video] wrote ${arrayBuffer.byteLength} bytes → ${webmPath}`);

  try {
    await convertToMp4(webmPath, mp4Path);
    await unlink(webmPath);
    console.log(`[save-video] converted → ${mp4Path}`);
    return NextResponse.json({ filename: `${base}.mp4`, folder: VIDEOS_FOLDER, filePath: mp4Path });
  } catch (err) {
    // Conversion failed — keep the webm so the user has something
    return NextResponse.json(
      { filename: `${base}.webm`, folder: VIDEOS_FOLDER, filePath: webmPath, conversionError: String(err) },
      { status: 200 },
    );
  }
}
