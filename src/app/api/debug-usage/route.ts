import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/usageTracker";

export async function GET() {
  return NextResponse.json(getUsageSnapshot());
}
