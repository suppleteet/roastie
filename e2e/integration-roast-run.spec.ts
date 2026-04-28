/**
 * Integration roast-run — drives a full conversation against the REAL joke /
 * question generation APIs so we can catch bugs that only surface end-to-end.
 *
 * What's mocked: vision, ElevenLabs TTS, mic, Gemini Live STT, save-* utilities,
 * rephrase-question and ambient-context (kept fast and free).
 *
 * What's real: /api/comedian-session, /api/generate-joke, /api/generate-speak,
 * /api/generate-question — these hit the configured LLM providers using the
 * project's API keys.
 *
 * Why this exists: the existing roast-run.spec.ts mocks joke generation, so it
 * can't catch bugs like flow stalling, repeat questions, jokes breaking the
 * rules in avoidTopics, or the LLM producing empty/garbage responses under
 * the actual prompt the app sends.
 *
 * Cost: every run hits production LLM APIs once per cycle (≈6–10 calls).
 * Skipped by default — set RUN_INTEGRATION_TEST=1 to enable, or run with
 * `npx playwright test integration-roast-run`.
 */

import { test, expect } from "@playwright/test";
import { RealLlmDriver } from "./helpers/realLlmDriver";

const ANSWERS = [
  "My name is Alex",
  "I'm a software engineer at a startup",
  "I have two cats named Pickle and Biscuit",
  "I live in Seattle near Capitol Hill",
  "I've been doing this for about three years",
];

/** Generous — real LLM calls are 1.3–3.2s each, plus drain/rephrase overhead. */
const CYCLE_TIMEOUT_MS = 60_000;

/** Words/phrases that violate the hardest rules in avoidTopics.ts. Programmatic
 *  detection is necessarily shallow — false negatives are fine, false positives
 *  are not. Keep this list tight. */
const HARD_RULE_KEYWORDS: { rule: string; words: RegExp }[] = [
  { rule: "self-harm/suicide", words: /\b(kill yourself|suicide|end it all|suicide note|kys)\b/i },
  { rule: "race/ethnicity slur", words: /\b(n[i1]gg[ae]r|ch[i1]nk|sp[i1]c|k[i1]ke|wetback|towelhead)\b/i },
];

const RUN = process.env.RUN_INTEGRATION_TEST === "1";

test.describe("Integration Roast Run", () => {
  test.skip(!RUN, "Set RUN_INTEGRATION_TEST=1 to run (real LLM calls cost money).");

  test("real-LLM Q&A: flow completes, no repeat questions, jokes don't violate hard rules", async ({ page }) => {
    test.setTimeout(360_000);

    const driver = new RealLlmDriver(page);
    await driver.setup();

    // Override fast config so the test paces realistically:
    // answerWaitMs long enough that prodding doesn't fire while we type.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__COMEDIAN_CONFIG__ = {
        answerWaitMs: 4000,
        answerSilenceMs: 800,
        speculativeMinWords: 2,
        maxProds: 1,
        greetingVisionTimeoutMs: 600,
        hopperMaxSize: 4,
        visionIntervalMs: 10_000,
        confirmationEnabled: false,
      };
      (window as unknown as Record<string, unknown>).__SESSION_ROTATE_MS__ = 600_000;
    });

    // Forward console errors so flow-ending bugs surface in test output.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto("/");
    await page.getByRole("button", { name: /roast me/i }).click();
    await driver.waitForConnect();

    await page.locator("[data-testid='hud-overlay']").waitFor({ timeout: 15_000 });
    await driver.startStateTracking();

    const debugInput = page.getByPlaceholder("type answer (enter to submit)…");
    const POST_ANSWER_STATES = [
      "pre_generate", "generating", "delivering", "confirm_answer",
      "check_vision", "vision_react", "ask_question", "prodding",
    ] as const;

    const questionsAsked: string[] = [];

    for (let i = 0; i < ANSWERS.length; i++) {
      const answer = ANSWERS[i];

      await driver.waitForBrainState("wait_answer", CYCLE_TIMEOUT_MS);

      // Snapshot the question that was just asked (may be empty briefly during state churn).
      const q = await driver.getCurrentQuestion();
      if (q) questionsAsked.push(q);

      // Small pause so the silence timer baseline resets cleanly.
      await page.waitForTimeout(400);

      await expect(debugInput).toBeVisible({ timeout: 5000 });
      await debugInput.fill(answer);
      await debugInput.press("Enter");

      await driver.waitForBrainStateOneOf([...POST_ANSWER_STATES], 10_000);
      console.log(`[cycle ${i + 1}/${ANSWERS.length}] "${answer}" → q="${q ?? "?"}"`);
    }

    // Wait for the brain to finish processing the last answer and return to wait_answer.
    await driver.waitForBrainState("wait_answer", CYCLE_TIMEOUT_MS);
    const finalQ = await driver.getCurrentQuestion();
    if (finalQ) questionsAsked.push(finalQ);

    // ─── Collect results ────────────────────────────────────────────────────────
    const timingLog = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("roastie-timing-log") ?? "[]") as string[]
    );
    const transcript = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("roastie-transcript") ?? "[]") as Array<{
        role: string; text: string; ts: number;
      }>
    );
    const ttsRequests = driver.getTtsRequests();
    const stateHistory = timingLog
      .filter((l) => l.includes("brain: →"))
      .map((l) => l.split("brain: →")[1]?.trim() ?? "")
      .filter(Boolean);

    // Save log to .debug for offline inspection.
    await page.request.post("/api/save-log", {
      data: {
        trigger: "playwright-integration-roast-run",
        sessionStartTs: null,
        timingLog,
        transcriptHistory: transcript,
      },
    }).catch(() => { /* best-effort */ });

    // ─── Bug detection ─────────────────────────────────────────────────────────
    const issues: string[] = [];

    // 1. Double state transitions
    for (let i = 1; i < timingLog.length; i++) {
      const prev = timingLog[i - 1];
      const curr = timingLog[i];
      if (prev.includes("brain: →") && curr.includes("brain: →")) {
        const prevState = prev.split("brain: →")[1]?.trim();
        const currState = curr.split("brain: →")[1]?.trim();
        if (prevState && prevState === currState) {
          issues.push(`Double → ${prevState}`);
        }
      }
    }

    // 2. Empty deliveries — brain ended up with nothing to say.
    //    "speculative returned empty" is benign (partial-answer prefetch can legitimately
    //    return nothing; fresh generation runs after) and is intentionally excluded.
    timingLog
      .filter((l) =>
        l.includes("stream delivered nothing") ||
        l.includes("enterDelivering with nothing"),
      )
      .forEach((l) => issues.push(`Empty delivery: ${l}`));

    // 3. Errors
    timingLog
      .filter((l) => l.includes("ERROR") || l.includes(": error —"))
      .forEach((l) => issues.push(`Timing error: ${l}`));
    consoleErrors.forEach((e) => issues.push(`Console error: ${e}`));

    // 4. Repeat questions — exact duplicates of the same question text across cycles.
    //    Names are normalized (lowercase, collapsed whitespace, stripped trailing punctuation).
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[?.!,]+$/g, "").trim();
    const seen = new Map<string, number>();
    for (const q of questionsAsked) {
      const key = norm(q);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [q, count] of seen) {
      if (count > 1) issues.push(`Repeat question (×${count}): "${q}"`);
    }

    // 5. Hard-rule violations across all puppet lines.
    const puppetLines = transcript.filter((e) => e.role === "puppet");
    const userLines = transcript.filter((e) => e.role === "user");
    for (const line of puppetLines) {
      for (const { rule, words } of HARD_RULE_KEYWORDS) {
        if (words.test(line.text)) {
          issues.push(`Hard rule violation [${rule}]: "${line.text}"`);
        }
      }
    }

    // 6. Puppet went mute — at least one delivery per cycle is expected.
    if (puppetLines.length < ANSWERS.length) {
      issues.push(`Puppet under-delivered: ${puppetLines.length} lines for ${ANSWERS.length} cycles`);
    }

    // ─── Report ────────────────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════");
    console.log("  INTEGRATION ROAST RUN COMPLETE");
    console.log("══════════════════════════════════════");
    console.log(`  TTS requests   : ${ttsRequests.length}`);
    console.log(`  Puppet lines   : ${puppetLines.length}`);
    console.log(`  User lines     : ${userLines.length}`);
    console.log(`  State visits   : ${stateHistory.length}`);
    console.log(`  Questions      : ${questionsAsked.length}`);
    console.log(`  Issues found   : ${issues.length}`);
    console.log("");
    console.log("STATE PATH:");
    console.log("  " + stateHistory.join(" → "));
    console.log("");
    console.log("QUESTIONS ASKED:");
    questionsAsked.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
    console.log("");
    if (issues.length > 0) {
      console.log("ISSUES:");
      issues.forEach((issue) => console.log(`  ✗ ${issue}`));
      console.log("");
    }
    console.log("TRANSCRIPT:");
    transcript.forEach((e) => {
      const tag = e.role === "puppet" ? "🎭" : "👤";
      console.log(`  ${tag} ${e.text}`);
    });
    console.log("══════════════════════════════════════\n");

    // ─── Assertions ────────────────────────────────────────────────────────────
    expect(puppetLines.length, "Puppet never spoke").toBeGreaterThan(0);
    expect(userLines.length, "No user answers recorded").toBeGreaterThanOrEqual(ANSWERS.length);
    expect(stateHistory, "Never reached generating").toContain("generating");
    expect(stateHistory, "Never reached delivering").toContain("delivering");

    const doubleTransitions = issues.filter((i) => i.startsWith("Double →"));
    expect(doubleTransitions, `Double transitions: ${doubleTransitions.join(", ")}`).toHaveLength(0);

    const repeats = issues.filter((i) => i.startsWith("Repeat question"));
    expect(repeats, `Repeat questions detected: ${repeats.join(" | ")}`).toHaveLength(0);

    const ruleBreaks = issues.filter((i) => i.startsWith("Hard rule violation"));
    expect(ruleBreaks, `Joke rule violations: ${ruleBreaks.join(" | ")}`).toHaveLength(0);

    const emptyDeliveries = issues.filter((i) => i.startsWith("Empty delivery"));
    expect(emptyDeliveries, `Empty deliveries: ${emptyDeliveries.join(" | ")}`).toHaveLength(0);

    const errs = issues.filter((i) => i.startsWith("Console error") || i.startsWith("Timing error"));
    expect(errs, `Errors during run: ${errs.join(" | ")}`).toHaveLength(0);
  });
});
