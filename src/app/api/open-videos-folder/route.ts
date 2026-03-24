import { NextResponse } from "next/server";
import { exec } from "child_process";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const VIDEOS_FOLDER = join(tmpdir(), "roastme-videos");

export async function POST() {
  await mkdir(VIDEOS_FOLDER, { recursive: true });

  // Open folder in the OS file explorer (Windows: explorer, macOS: open, Linux: xdg-open)
  const cmd =
    process.platform === "win32"
      ? `explorer "${VIDEOS_FOLDER}"`
      : process.platform === "darwin"
      ? `open "${VIDEOS_FOLDER}"`
      : `xdg-open "${VIDEOS_FOLDER}"`;

  exec(cmd);

  return NextResponse.json({ ok: true, folder: VIDEOS_FOLDER });
}
