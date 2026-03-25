"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore, TIMELINE_ROW_COLORS, type TimelineRow } from "@/store/useSessionStore";

const ROWS: TimelineRow[] = ["user", "gemini", "tts", "vision", "session"];
const ROW_LABELS: Record<TimelineRow, string> = {
  user: "User VAD",
  gemini: "Gemini",
  tts: "TTS fetch",
  vision: "Vision",
  session: "Session",
};

const LABEL_WIDTH = 82;
const RIGHT_PAD = 24;
const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 20;
const PADDING_V = 8;
const TICK_INTERVAL_MS = 100;
const VISIBLE_MS = 8000;

// Total canvas CSS height
const CANVAS_HEIGHT = PADDING_V + HEADER_HEIGHT + ROWS.length * ROW_HEIGHT + PADDING_V;

export default function DebugTimeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phase = useSessionStore((s) => s.phase);
  const [collapsed, setCollapsed] = useState(phase !== "roasting");
  const [paused, setPaused] = useState(false);

  // Auto-collapse when leaving the roasting phase
  useEffect(() => {
    if (phase !== "roasting") setCollapsed(true);
  }, [phase]);
  const pausedRef = useRef(false);
  const frozenNowRef = useRef<number | null>(null);

  // Keep ref in sync so the rAF closure reads latest value without re-running effect
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      frozenNowRef.current = Date.now();
    } else {
      frozenNowRef.current = null;
    }
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId: number;

    function draw() {
      if (!canvas || !ctx) return;

      // Handle DPR / resize
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.offsetWidth;
      const cssH = canvas.offsetHeight;
      if (cssW === 0 || cssH === 0) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const W = cssW;
      const H = cssH;
      const timelineX = LABEL_WIDTH;
      const timelineW = W - LABEL_WIDTH - RIGHT_PAD;
      const rightEdge = timelineX + timelineW;
      const now = frozenNowRef.current ?? Date.now();
      const pxPerMs = timelineW / VISIBLE_MS;

      // Background
      ctx.fillStyle = "#080810";
      ctx.fillRect(0, 0, W, H);

      // Alternating row bands
      ROWS.forEach((_, i) => {
        const y = PADDING_V + HEADER_HEIGHT + i * ROW_HEIGHT;
        ctx.fillStyle = i % 2 === 0 ? "#0c0c18" : "#080810";
        ctx.fillRect(timelineX, y, timelineW, ROW_HEIGHT);
      });

      // 100ms tick lines (pan with time)
      const msOffsetToFirstTick = now % TICK_INTERVAL_MS;
      for (let i = 0; ; i++) {
        const msAgo = msOffsetToFirstTick + i * TICK_INTERVAL_MS;
        if (msAgo > VISIBLE_MS) break;
        const x = rightEdge - msAgo * pxPerMs;
        if (x < timelineX) break;

        const absoluteMs = now - msAgo;
        const isMajor = absoluteMs % 1000 === 0;

        ctx.strokeStyle = isMajor ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.05)";
        ctx.lineWidth = isMajor ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PADDING_V);
        ctx.lineTo(x, H - PADDING_V);
        ctx.stroke();

        // Time labels on major ticks
        if (isMajor) {
          const secsAgo = Math.round(msAgo / 1000);
          ctx.fillStyle = "rgba(255,255,255,0.22)";
          ctx.font = "11px monospace";
          ctx.textAlign = "center";
          ctx.fillText(`-${secsAgo}s`, x, PADDING_V + 13);
        }
      }

      // "now" indicator (amber when paused)
      const isPaused = pausedRef.current;
      ctx.strokeStyle = isPaused ? "rgba(251,191,36,0.7)" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = isPaused ? 1.5 : 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(rightEdge, PADDING_V);
      ctx.lineTo(rightEdge, H - PADDING_V);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isPaused ? "rgba(251,191,36,0.8)" : "rgba(255,255,255,0.35)";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(isPaused ? "paused" : "now", rightEdge, PADDING_V + 13);

      // Spans
      const spans = useSessionStore.getState().timelineSpans;
      spans.forEach((span) => {
        const rowIdx = ROWS.indexOf(span.row as TimelineRow);
        if (rowIdx === -1) return;

        const endTs = span.endTs ?? now;
        const startMsAgo = now - span.startTs;
        const endMsAgo = now - endTs;

        // Skip completed spans that have fully scrolled off the left edge.
        // Ongoing spans (endTs === null) are always shown — clamped to left edge.
        if (span.endTs !== null && startMsAgo > VISIBLE_MS) return;

        const x1 = Math.max(timelineX, rightEdge - startMsAgo * pxPerMs);
        const x2 = Math.min(rightEdge, rightEdge - endMsAgo * pxPerMs);
        const boxW = Math.max(1, x2 - x1);
        const boxY = PADDING_V + HEADER_HEIGHT + rowIdx * ROW_HEIGHT + 3;
        const boxH = ROW_HEIGHT - 6;

        // Ongoing spans pulse slightly
        const alpha = span.endTs ? "ee" : "cc";
        ctx.fillStyle = span.color + alpha;
        ctx.beginPath();
        ctx.roundRect(x1, boxY, boxW, boxH, 3);
        ctx.fill();

        // Label inside box if wide enough
        if (boxW > 30) {
          const durationMs = endTs - span.startTs;
          const text = span.endTs
            ? `${span.label} ${durationMs}ms`
            : `${span.label} ${durationMs}ms…`;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 1, boxY, boxW - 2, boxH);
          ctx.clip();
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.font = "bold 11px monospace";
          ctx.textAlign = "left";
          ctx.fillText(text, x1 + 4, boxY + boxH / 2 + 3.5);
          ctx.restore();
        }
      });

      // Row labels (left column)
      ROWS.forEach((row, i) => {
        const y = PADDING_V + HEADER_HEIGHT + i * ROW_HEIGHT;

        // Separator line
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();

        // Label text
        ctx.fillStyle = TIMELINE_ROW_COLORS[row as TimelineRow];
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "right";
        ctx.fillText(ROW_LABELS[row as TimelineRow], LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 + 3.5);
      });

      // Divider between label column and timeline
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, PADDING_V);
      ctx.lineTo(LABEL_WIDTH, H - PADDING_V);
      ctx.stroke();

      rafId = requestAnimationFrame(draw);
    }

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      className="fixed bottom-0 right-0 z-40"
      style={{ left: 52, background: "rgba(4,4,12,0.92)", backdropFilter: "blur(6px)" }}
    >
      {/* Header bar — always visible, click to collapse */}
      <div
        className="flex items-center justify-between px-3 py-1 cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
        style={{ borderBottom: collapsed ? "none" : "1px solid rgba(255,255,255,0.06)" }}
      >
        <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-white/30">
          {collapsed ? "▲ timeline" : "▼ timeline"}
        </span>
        {!collapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); setPaused((p) => !p); }}
            className="text-[10px] font-mono font-bold px-2 py-0.5 rounded border transition-colors pointer-events-auto"
            style={
              paused
                ? { color: "#fbbf24", borderColor: "rgba(251,191,36,0.5)", background: "rgba(251,191,36,0.1)" }
                : { color: "rgba(255,255,255,0.4)", borderColor: "rgba(255,255,255,0.15)", background: "transparent" }
            }
          >
            {paused ? "▶ play" : "⏸ pause"}
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="px-3 pb-2">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: `${CANVAS_HEIGHT}px`, display: "block" }}
          />
        </div>
      )}
    </div>
  );
}
