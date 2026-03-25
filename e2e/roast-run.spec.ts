/**
 * Full roast-run E2E — simulates a real multi-cycle conversation using the
 * debug text input so we can exercise the whole brain/TTS pipeline and catch
 * state machine bugs at conversation speed.
 *
 * Answers are typed into the debug input (visible when brain is listening).
 * Timing is moderate — fast enough to complete in < 2 min, slow enough that
 * the debug input is actually usable and silence timers fire at realistic cadence.
 *
 * After all cycles complete:
 *   - Saves the session log to .debug/last-session.json
 *   - Prints the full timing log + transcript to stdout
 *   - Reports any detected issues (double transitions, empty deliveries, errors)
 */

import { test, expect } from "@playwright/test";
import { ComedianBrainDriver } from "./helpers/comedianBrainDriver";

const ANSWERS = [
  "My name is Alex",
  "I'm a software engineer at a startup",
  "I have two cats named Pickle and Biscuit",
  "I live in Seattle near Capitol Hill",
  "I've been doing this for about three years",
  "My hobby is playing guitar very badly",
];

// How long to wait for the brain to reach wait_answer between cycles.
// With mocked APIs (instant TTS) and moderate config, each cycle takes ~2-4s.
const CYCLE_TIMEOUT_MS = 25_000;

test.describe("Full Roast Run", () => {
  test("plays through 6 Q&A cycles via debug text input", async ({ page }) => {
    test.setTimeout(120_000); // 2-minute ceiling

    const driver = new ComedianBrainDriver(page);
    await driver.setup();

    // Override the fast config the driver injects — needs to be added AFTER driver.setup()
    // so it runs last and wins. answerWaitMs must be long enough for Playwright to type.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__COMEDIAN_CONFIG__ = {
        answerWaitMs: 3000,      // 3s before prodding (gives Playwright time to type)
        answerSilenceMs: 800,    // 0.8s silence triggers generation
        speculativeMinWords: 2,  // speculative on 2+ words
        maxProds: 1,
        greetingVisionTimeoutMs: 600,
        hopperMaxSize: 4,
        visionIntervalMs: 3000,
      };
    });

    await page.goto("/");
    await driver.waitForConnect();

    // Wait for HUDOverlay to be in the DOM before starting state tracking
    await page.locator("[data-testid='hud-overlay']").waitFor({ timeout: 10_000 });
    await driver.startStateTracking();

    const debugInput = page.getByPlaceholder("type answer (enter to submit)…");
    // States that confirm the brain received an answer and left wait_answer
    const POST_ANSWER_STATES = [
      "pre_generate", "generating", "delivering",
      "check_vision", "vision_react", "ask_question", "prodding",
    ] as const;

    // ─── Run cycles ──────────────────────────────────────────────────────────────

    for (let i = 0; i < ANSWERS.length; i++) {
      const answer = ANSWERS[i];

      await driver.waitForBrainState("wait_answer", CYCLE_TIMEOUT_MS);

      // Small pause so silence timer resets cleanly after wait_answer entry
      await page.waitForTimeout(400);

      await expect(debugInput).toBeVisible({ timeout: 5000 });
      await debugInput.fill(answer);
      await debugInput.press("Enter");

      // IMPORTANT: wait for brain to leave wait_answer before moving to next cycle.
      // Without this, the next waitForBrainState("wait_answer") resolves immediately
      // (brain is still in wait_answer) and cycle N+1 overwrites cycle N's answer.
      await driver.waitForBrainStateOneOf([...POST_ANSWER_STATES], 5000);

      console.log(`[cycle ${i + 1}/${ANSWERS.length}] → "${answer}"`);
    }

    // Wait for the brain to process the last answer and return to wait_answer
    await driver.waitForBrainState("wait_answer", CYCLE_TIMEOUT_MS);

    // ─── Collect results ─────────────────────────────────────────────────────────

    const timingLog = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("roastie-timing-log") ?? "[]") as string[]
    );
    const transcript = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("roastie-transcript") ?? "[]") as Array<{
        role: string; text: string; ts: number;
      }>
    );
    const ttsRequests = driver.getTtsRequests();
    // Derive state path from timing log — more reliable than MutationObserver
    // (rapid React batching can cause the DOM observer to miss transient states)
    const stateHistory = timingLog
      .filter((l) => l.includes("brain: →"))
      .map((l) => l.split("brain: →")[1]?.trim() ?? "")
      .filter(Boolean);

    // Save to .debug/last-session.json so it can be read between test runs
    await page.request.post("/api/save-log", {
      data: {
        trigger: "playwright-roast-run",
        sessionStartTs: null,
        timingLog,
        transcriptHistory: transcript,
      },
    }).catch(() => { /* best-effort */ });

    // ─── Bug detection ───────────────────────────────────────────────────────────

    const issues: string[] = [];

    // 1. Consecutive duplicate state transitions
    for (let i = 1; i < timingLog.length; i++) {
      const prev = timingLog[i - 1];
      const curr = timingLog[i];
      if (prev.includes("brain: →") && curr.includes("brain: →")) {
        const prevState = prev.split("brain: →")[1]?.trim();
        const currState = curr.split("brain: →")[1]?.trim();
        if (prevState && prevState === currState) {
          issues.push(`Double → ${prevState}  (${curr.split(" ")[0]})`);
        }
      }
    }

    // 2. Empty deliveries (API returned relevant but no jokes)
    timingLog
      .filter((l) => l.includes("stream delivered nothing") || l.includes("enterDelivering with nothing"))
      .forEach((l) => issues.push(`Empty delivery: ${l}`));

    // 3. API or live errors
    timingLog
      .filter((l) => l.includes("ERROR") || l.includes(": error —"))
      .forEach((l) => issues.push(`Error: ${l}`));

    // 4. Speculative waste (reused speculative → still empty)
    timingLog
      .filter((l) => l.includes("speculative returned empty"))
      .forEach((l) => issues.push(`Speculative empty: ${l}`));

    // 5. Puppet spoke nothing at all (bot went completely mute)
    const puppetLines = transcript.filter((e) => e.role === "puppet");
    const userLines = transcript.filter((e) => e.role === "user");

    // ─── Report ──────────────────────────────────────────────────────────────────

    console.log("\n══════════════════════════════════════");
    console.log("  ROAST RUN COMPLETE");
    console.log("══════════════════════════════════════");
    console.log(`  TTS requests  : ${ttsRequests.length}`);
    console.log(`  Puppet lines  : ${puppetLines.length}`);
    console.log(`  User lines    : ${userLines.length}`);
    console.log(`  State visits  : ${stateHistory.length}`);
    console.log(`  Issues found  : ${issues.length}`);
    console.log("");
    console.log("STATE PATH:");
    console.log("  " + stateHistory.join(" → "));
    console.log("");
    if (issues.length > 0) {
      console.log("ISSUES:");
      issues.forEach((issue) => console.log(`  ✗ ${issue}`));
      console.log("");
    }
    console.log("TIMING LOG:");
    timingLog.forEach((l) => console.log(`  ${l}`));
    console.log("");
    console.log("TRANSCRIPT:");
    transcript.forEach((e) => {
      const tag = e.role === "puppet" ? "🎭" : "👤";
      console.log(`  ${tag} ${e.text}`);
    });
    console.log("══════════════════════════════════════\n");

    // ─── Assertions ──────────────────────────────────────────────────────────────

    expect(puppetLines.length, "Puppet never spoke").toBeGreaterThan(0);
    expect(userLines.length, "No user answers recorded").toBeGreaterThan(0);
    expect(stateHistory, "Never reached generating").toContain("generating");
    expect(stateHistory, "Never reached delivering").toContain("delivering");

    // Double transitions are a bug — fail if we see any
    const doubleTransitions = issues.filter((i) => i.startsWith("Double →"));
    expect(doubleTransitions, `Double state transitions: ${doubleTransitions.join(", ")}`).toHaveLength(0);
  });
});
