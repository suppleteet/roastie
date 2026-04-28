import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { VIDEOS_FOLDER } from "@/lib/videoPaths";

export async function POST() {
  await mkdir(VIDEOS_FOLDER, { recursive: true });

  const [command, ...args] =
    process.platform === "win32"
      ? ["explorer.exe", VIDEOS_FOLDER]
      : process.platform === "darwin"
        ? ["open", VIDEOS_FOLDER]
        : ["xdg-open", VIDEOS_FOLDER];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return NextResponse.json({ ok: true, folder: VIDEOS_FOLDER });
}
