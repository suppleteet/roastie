/**
 * Model latency benchmark — measures generate-joke response time
 * across different Gemini models. Hits the API directly, no browser.
 *
 * Usage:  node scripts/bench-models.mjs
 * Requires: GEMINI_API_KEY in .env.local or environment
 */

import { readFileSync } from "fs";

// Load .env.local manually (no dotenv dependency)
try {
  const env = readFileSync(".env.local", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch { /* no .env.local */ }

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not set. Add it to .env.local");
  process.exit(1);
}

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-3-flash-preview",
];

const PROMPT = {
  context: "answer_roast",
  persona: "kvetch",
  burnIntensity: 5,
  contentMode: "vulgar",
  question: "What's your name?",
  userAnswer: "Tyler",
  knownFacts: [],
  observations: ["bearded man", "wearing hoodie", "sitting at desk"],
};

const SYSTEM_PROMPT = `You are "The Kvetch", a roast comedian. Generate 1 joke roasting the user's answer.
Return ONLY valid JSON: {"relevant":true,"jokes":[{"text":"...","motion":"smug","intensity":0.8,"score":7}]}`;

const RUNS = 5;

async function benchModel(model) {
  const times = [];

  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: `QUESTION: "${PROMPT.question}"\nANSWER: "${PROMPT.userAnswer}"\nOBSERVATIONS: ${PROMPT.observations.join("; ")}` }] }],
            generationConfig: {
              maxOutputTokens: 200,
              // thinkingConfig not supported on all models
            },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );

      const elapsed = performance.now() - start;

      if (!resp.ok) {
        const err = await resp.text();
        console.log(`  ${model} run ${i + 1}: ERROR ${resp.status} (${elapsed.toFixed(0)}ms) — ${err.slice(0, 100)}`);
        continue;
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty)";
      times.push(elapsed);
      console.log(`  ${model} run ${i + 1}: ${elapsed.toFixed(0)}ms — ${text.slice(0, 80)}`);
    } catch (e) {
      const elapsed = performance.now() - start;
      console.log(`  ${model} run ${i + 1}: FAIL (${elapsed.toFixed(0)}ms) — ${e.message}`);
    }
  }

  return times;
}

async function main() {
  console.log(`\nBenchmarking ${RUNS} runs per model...\n`);

  const results = {};

  for (const model of MODELS) {
    console.log(`\n─── ${model} ───`);
    const times = await benchModel(model);
    results[model] = times;
  }

  console.log("\n\n═══════════════════════════════════════");
  console.log("  MODEL BENCHMARK RESULTS");
  console.log("═══════════════════════════════════════");

  for (const [model, times] of Object.entries(results)) {
    if (times.length === 0) {
      console.log(`  ${model}: NO SUCCESSFUL RUNS`);
      continue;
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const p50 = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
    console.log(`  ${model}:`);
    console.log(`    avg: ${avg.toFixed(0)}ms  min: ${min.toFixed(0)}ms  max: ${max.toFixed(0)}ms  p50: ${p50.toFixed(0)}ms  (${times.length}/${RUNS} ok)`);
  }

  console.log("═══════════════════════════════════════\n");
}

main();
