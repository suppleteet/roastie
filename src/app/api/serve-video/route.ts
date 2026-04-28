import { NextRequest, NextResponse } from "next/server";
import { open, stat } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { VIDEOS_FOLDER } from "@/lib/videoPaths";
import {
  contentTypeForVideoFilename,
  isSafeVideoFilename,
} from "@/lib/mediaRecorderSupport";
import { parseRangeHeader } from "@/lib/httpRange";

export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get("filename");
  if (!isSafeVideoFilename(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = join(VIDEOS_FOLDER, filename);
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const contentType = contentTypeForVideoFilename(filename);
  const rangeHeader = req.headers.get("range");
  const range = parseRangeHeader(rangeHeader, fileSize);

  if (rangeHeader && !range) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileSize - 1);
  const contentLength = fileSize === 0 ? 0 : end - start + 1;

  const file = await open(filePath, "r");
  const nodeStream = file.createReadStream({ start, end });
  nodeStream.on("close", () => {
    void file.close().catch(() => {});
  });

  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${fileSize}` } : {}),
    },
  });
}
