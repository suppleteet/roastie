import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

const env = fs.readFileSync("c:/Projects/Roastie/.env.local", "utf8");
const oaiKey = env.match(/OPENAI_API_KEY=(.+)/)[1].trim();
const gemKey = env.match(/GEMINI_API_KEY=(.+)/)[1].trim();
const antKey = env.match(/ANTHROPIC_API_KEY=(.+)/)[1].trim();

// ─── Test scenarios ──────────────────────────────────────────────────────────

const answerQuestions = [
  // Round 1 — original answers
  { q: "What is your name?", a: "Tyler", label: "Name → Tyler", ctx: "answer_roast" },
  { q: "What do you do for a living?", a: "I'm a software engineer", label: "Job → Software engineer", ctx: "answer_roast" },
  { q: "How old are you?", a: "42", label: "Age → 42", ctx: "answer_roast" },
  { q: "Are you single?", a: "No, I'm married", label: "Married? → Yes", ctx: "answer_roast" },
  // Round 2 — different answers
  { q: "What is your name?", a: "Brenda", label: "Name → Brenda", ctx: "answer_roast" },
  { q: "What do you do for a living?", a: "I'm a kindergarten teacher", label: "Job → Kindergarten teacher", ctx: "answer_roast" },
  { q: "How old are you?", a: "23", label: "Age → 23", ctx: "answer_roast" },
  { q: "Are you single?", a: "Yeah, recently divorced", label: "Single → Divorced", ctx: "answer_roast" },
  // Round 3 — more variety
  { q: "What is your name?", a: "Doug", label: "Name → Doug", ctx: "answer_roast" },
  { q: "What do you do for a living?", a: "I sell cars", label: "Job → Car salesman", ctx: "answer_roast" },
  { q: "How old are you?", a: "67", label: "Age → 67", ctx: "answer_roast" },
  { q: "Are you single?", a: "It's complicated", label: "Single → Complicated", ctx: "answer_roast" },
];

const visionQuestions = [
  {
    label: "Vision → Bald guy in car",
    ctx: "vision_react",
    observations: ["bald head", "glasses", "sitting in car", "steering wheel visible", "serious expression"],
  },
  {
    label: "Vision → Bearded guy at desk",
    ctx: "vision_react",
    observations: ["full beard", "messy desk", "energy drink can", "headphones around neck", "dark room"],
  },
];

const models = [
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gemini-2.5-flash", label: "Gemini Flash" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

// ─── Step 1: Generate jokes ──────────────────────────────────────────────────

console.log("Generating jokes from all 4 models across 14 scenarios...");

const allJokes = [];
let idCounter = 1;

const genPromises = [];

// Answer-based jokes
for (const q of answerQuestions) {
  for (const m of models) {
    genPromises.push(
      fetch("http://localhost:3000/api/generate-joke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: q.ctx,
          model: m.id,
          persona: "kvetch",
          burnIntensity: 5,
          contentMode: "vulgar",
          question: q.q,
          userAnswer: q.a,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          for (const joke of (data.jokes || []).slice(0, 2)) {
            allJokes.push({ id: idCounter++, q: q.label, model: m.label, text: joke.text });
          }
        })
        .catch((e) => console.error(`  FAIL: ${m.label} / ${q.label}: ${e.message}`))
    );
  }
}

// Vision jokes
for (const v of visionQuestions) {
  for (const m of models) {
    genPromises.push(
      fetch("http://localhost:3000/api/generate-joke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: v.ctx,
          model: m.id,
          persona: "kvetch",
          burnIntensity: 5,
          contentMode: "vulgar",
          observations: v.observations,
          maxJokes: 1,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          for (const joke of (data.jokes || []).slice(0, 1)) {
            allJokes.push({ id: idCounter++, q: v.label, model: m.label, text: joke.text });
          }
        })
        .catch((e) => console.error(`  FAIL: ${m.label} / ${v.label}: ${e.message}`))
    );
  }
}

await Promise.all(genPromises);
console.log(`Generated ${allJokes.length} jokes. Sending to 4 blind judges...\n`);

// ─── Step 2: Shuffle and build blind list ────────────────────────────────────

const shuffled = [...allJokes].sort(() => Math.random() - 0.5);
const blindList = shuffled.map((j, i) => `${i + 1}. (Q: ${j.q}) "${j.text}"`).join("\n");

const sysPrompt = `You are judging roast jokes for a live comedy show. The comedian is an old, grizzled, annoyed Muppet-style puppet — think Don Rickles meets Statler & Waldorf. He's been doing this 40 years. He's mean but clever, never modern or trendy.

Score each joke 1-10 on how hard it would land in a LIVE roast setting with an audience. Consider:
- Originality (not a joke everyone's heard)
- Specificity (paints a picture vs generic insult)
- Character voice (does it sound like a cranky old puppet?)
- Punchline punch (does it land hard at the end?)
- Brevity (tight delivery vs rambling)

Be harsh. A 5 is mediocre. 7+ means genuinely funny. 9+ means the audience is howling.

Output ONLY a JSON object: {"scores":[{"n":1,"score":7,"note":"brief reason"},...]}.
The n values must match the numbers in my list (1 through ${shuffled.length}).`;

const userPrompt =
  "Score these roast jokes. You do NOT know who wrote them — judge purely on the joke:\n\n" + blindList;

// ─── Step 3: Four blind judges ───────────────────────────────────────────────

async function judgeGpt4o() {
  const client = new OpenAI({ apiKey: oaiKey });
  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return JSON.parse(r.choices[0].message.content);
}

async function judgeGemini() {
  const ai = new GoogleGenAI({ apiKey: gemKey });
  const r = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    config: {
      systemInstruction: sysPrompt,
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 8192,
    },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
  });
  return JSON.parse(r.text.match(/\{[\s\S]*\}/)[0]);
}

async function judgeSonnet() {
  const client = new Anthropic({ apiKey: antKey });
  const r = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: sysPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = r.content.find((b) => b.type === "text")?.text || "";
  return JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
}

async function judgeHaiku() {
  const client = new Anthropic({ apiKey: antKey });
  const r = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    system: sysPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = r.content.find((b) => b.type === "text")?.text || "";
  return JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
}

console.log("Judging...");
const judgeNames = ["GPT-4o", "Gemini", "Sonnet", "Haiku"];
const [r1, r2, r3, r4] = await Promise.all([
  judgeGpt4o().catch((e) => { console.error("GPT-4o judge failed:", e.message); return { scores: [] }; }),
  judgeGemini().catch((e) => { console.error("Gemini judge failed:", e.message); return { scores: [] }; }),
  judgeSonnet().catch((e) => { console.error("Sonnet judge failed:", e.message); return { scores: [] }; }),
  judgeHaiku().catch((e) => { console.error("Haiku judge failed:", e.message); return { scores: [] }; }),
]);

function mapScores(result) {
  const arr = result.scores || result;
  const map = {};
  for (const s of arr) {
    const orig = shuffled[s.n - 1];
    if (orig) map[orig.id] = { score: s.score, note: s.note };
  }
  return map;
}

const judges = [mapScores(r1), mapScores(r2), mapScores(r3), mapScores(r4)];

// ─── Step 4: Print per-question results ──────────────────────────────────────

const allLabels = [
  ...answerQuestions.map((q) => q.label),
  ...visionQuestions.map((v) => v.label),
];
// Deduplicate while preserving order
const uniqueLabels = [...new Set(allLabels)];

for (const q of uniqueLabels) {
  const qJokes = allJokes.filter((j) => j.q === q);
  if (qJokes.length === 0) continue;

  console.log(`\n=== ${q} ===`);

  // Sort by average score descending
  const scored = qJokes.map((j) => {
    const scores = judges.map((jm) => jm[j.id]?.score).filter((s) => typeof s === "number");
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return { ...j, scores: judges.map((jm) => jm[j.id]?.score ?? "-"), avg };
  }).sort((a, b) => b.avg - a.avg);

  for (const j of scored) {
    const scoreStr = j.scores.map((s) => String(s).padStart(5)).join(" ");
    const txt = j.text.length > 70 ? j.text.substring(0, 67) + "..." : j.text;
    console.log(`  ${j.avg.toFixed(1)} | ${j.model.padEnd(13)}| ${scoreStr} | ${txt}`);
  }
}

// ─── Step 5: Final scoreboard ────────────────────────────────────────────────

console.log("\n");
console.log("╔═══════════════════════════════════════════════════════════════════╗");
console.log("║  FINAL SCOREBOARD — 4 blind judges, fresh jokes, all rounds     ║");
console.log("╠═══════════════════════════════════════════════════════════════════╣");
console.log("║ Model         | GPT-4o  Gemini  Sonnet   Haiku | Combined  #jokes║");
console.log("╠═══════════════════════════════════════════════════════════════════╣");

const modelResults = [];
for (const m of models) {
  const mj = allJokes.filter((j) => j.model === m.label);
  if (mj.length === 0) {
    modelResults.push({ label: m.label, avgs: [0, 0, 0, 0], combined: 0, count: 0 });
    continue;
  }
  const avgs = judges.map(
    (jm) => {
      const valid = mj.filter((j) => typeof jm[j.id]?.score === "number");
      return valid.length ? valid.reduce((s, j) => s + jm[j.id].score, 0) / valid.length : 0;
    }
  );
  const validAvgs = avgs.filter((a) => a > 0);
  const combined = validAvgs.length ? validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length : 0;
  modelResults.push({ label: m.label, avgs, combined, count: mj.length });
}

modelResults.sort((a, b) => b.combined - a.combined);

for (const m of modelResults) {
  const avgStr = m.avgs.map((a) => a.toFixed(1).padStart(7)).join(" ");
  console.log(`║ ${m.label.padEnd(14)}| ${avgStr} |   ${m.combined.toFixed(1)}      ${String(m.count).padStart(3)} ║`);
}
console.log("╚═══════════════════════════════════════════════════════════════════╝");

// Top 5 jokes
console.log("\n🏆 TOP 5 JOKES (by average across all judges):");
const allScored = allJokes.map((j) => {
  const scores = judges.map((jm) => jm[j.id]?.score).filter((s) => typeof s === "number");
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return { ...j, avg };
}).sort((a, b) => b.avg - a.avg);

for (let i = 0; i < Math.min(5, allScored.length); i++) {
  const j = allScored[i];
  console.log(`  ${i + 1}. [${j.avg.toFixed(1)}] (${j.model}) ${j.text}`);
}

// Bottom 3
console.log("\n💀 BOTTOM 3:");
for (let i = allScored.length - 1; i >= Math.max(0, allScored.length - 3); i--) {
  const j = allScored[i];
  console.log(`  [${j.avg.toFixed(1)}] (${j.model}) ${j.text}`);
}
