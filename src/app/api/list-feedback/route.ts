import { NextRequest, NextResponse } from "next/server";
import { list } from "@vercel/blob";

export const dynamic = "force-dynamic";

/**
 * GET /api/list-feedback — List all feedback entries from Vercel Blob.
 * Returns { entries: [{ url, pathname, uploadedAt, text, type, persona, ... }] }
 *
 * Optional query params:
 *   ?limit=20     — max entries to return (default 50)
 *   ?type=critique — filter by feedback type
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const typeFilter = url.searchParams.get("type");

    const { blobs } = await list({ prefix: "feedback/", limit: 200 });

    // Sort newest first
    const sorted = blobs.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );

    // Optionally filter by type (encoded in filename: feedback-*, critique-*, joke-rating-*)
    const filtered = typeFilter
      ? sorted.filter((b) => b.pathname.includes(`/${typeFilter}-`))
      : sorted;

    const entries = filtered.slice(0, limit).map((b) => ({
      url: b.url,
      pathname: b.pathname,
      uploadedAt: b.uploadedAt,
      size: b.size,
    }));

    return NextResponse.json({ entries, total: filtered.length });
  } catch (err) {
    console.error("[list-feedback]", err);
    return NextResponse.json({ error: "Failed to list feedback" }, { status: 500 });
  }
}
