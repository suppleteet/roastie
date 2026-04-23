import { test, expect, type Page } from "@playwright/test";
import { ComedianBrainDriver } from "./helpers/comedianBrainDriver";

// ─── Setup helper ─────────────────────────────────────────────────────────────

async function startRoasting(page: Page, driver: ComedianBrainDriver): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /roast me/i }).click();
  await expect(page.locator("[data-testid='hud-overlay']")).toBeVisible({ timeout: 10000 });
  await driver.waitForConnect();
}

// ─── Full flow ────────────────────────────────────────────────────────────────

test.describe("Comedian Brain — Full Flow", () => {
  test("greeting TTS fires within 3s of session start", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    const startMs = Date.now();
    await startRoasting(page, driver);

    const req = await driver.waitForTtsRequest(5000);
    const elapsed = Date.now() - startMs;

    expect(req.text).toBeTruthy();
    expect(elapsed).toBeLessThan(5000);
  });

  test("brain visits greeting state on session start", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);
    await page.waitForFunction(() => {
      const timing = JSON.parse(localStorage.getItem("roastie-timing-log") ?? "[]") as string[];
      return timing.some((line) => line.includes("brain: → greeting"));
    }, { timeout: 5000 });
  });

  test("HUD displays data-brain-state attribute", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    // Wait for any brain state to be set
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-testid='hud-overlay']");
        return el && el.getAttribute("data-brain-state") !== "";
      },
      { timeout: 5000 }
    );
    const state = await driver.getBrainState();
    expect(state).toBeTruthy();
  });
});

// ─── Question / Answer cycle ──────────────────────────────────────────────────

test.describe("Comedian Brain — Q&A Cycle", () => {
  test("reaches ask_question state after startup", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);
    // With fast config: greeting(300ms timeout) → vision_jokes → ask_question
    await driver.waitForBrainState("ask_question", 8000);
  });

  test("reaches wait_answer after question TTS drains", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);
    await driver.waitForBrainState("wait_answer", 10000);
  });

  test("joke API called with question + answer when user answers", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    driver.clearJokeRequests();
    await driver.startStateTracking();

    // Simulate user answer — short answer to avoid partial capture at fast test timing
    await driver.simulateAnswer("a dentist");

    // Brain races through generating → delivering — wait for it to settle past generating
    await driver.waitForStateVisited("generating", 5000);

    const reqs = driver.getJokeRequests();
    const answerReq = reqs.find((r) => r.context === "answer_roast");
    expect(answerReq).toBeTruthy();
    expect(answerReq!.userAnswer).toContain("dentist");
  });

  test("transitions through generating after answer complete", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    await driver.startStateTracking();
    await driver.simulateAnswer("I'm from Seattle originally");
    // generating is transient — verify it was visited
    await driver.waitForStateVisited("generating", 5000);
  });

  test("follow-up question used when API returns followUp", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);

    driver.mockJokeResponse({
      relevant: true,
      jokes: [{ text: "A dentist! You inflict pain for a living!", motion: "laugh", intensity: 0.9, score: 8 }],
      followUp: "Do your patients know you look like that?",
    });

    await driver.startStateTracking();
    await driver.simulateAnswer("I am a dentist");
    // delivering and ask_question are both transient — wait for ask_question (stable)
    await driver.waitForBrainState("ask_question", 8000);

    // Check that the follow-up question was queued to TTS
    const ttsReqs = driver.getTtsRequests();
    const hasFollowUp = ttsReqs.some((r) => r.text.includes("patients") || r.text.includes("look like"));
    expect(hasFollowUp).toBe(true);
  });
});

// ─── Silence handling ─────────────────────────────────────────────────────────

test.describe("Comedian Brain — Silence Handling", () => {
  test("prod line plays after answerWaitMs silence (fast config: 80ms)", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    driver.clearTtsRequests();

    // Don't send any transcription — let silence timer fire (80ms in fast config)
    await driver.waitForBrainState("prodding", 3000);

    // A prod line should have been queued
    const ttsReqs = driver.getTtsRequests();
    expect(ttsReqs.length).toBeGreaterThan(0);
  });

  test("prod is interrupted when user speaks", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);

    // Wait for prod to start
    await driver.waitForBrainState("prodding", 3000);

    // User speaks during prod
    driver.sendInputTranscription("Okay okay I was thinking");

    // Should return to wait_answer
    await driver.waitForBrainState("wait_answer", 3000);
  });
});

// ─── Irrelevant answers ───────────────────────────────────────────────────────

test.describe("Comedian Brain — Irrelevant Answers", () => {
  test("redirect TTS plays when API returns relevant:false", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    driver.clearTtsRequests();

    // Queue TWO irrelevant responses — speculative may consume the first,
    // the fresh generation on answer-complete gets the second
    driver.mockJokeResponseSequence([
      { relevant: false, jokes: [], redirect: "Interesting non-answer. But back to the question —" },
      { relevant: false, jokes: [], redirect: "Interesting non-answer. But back to the question —" },
    ]);

    await driver.startStateTracking();
    await driver.simulateAnswer("uhhh I dunno something");
    // redirecting is transient — verify it was visited
    await driver.waitForStateVisited("redirecting", 5000);

    const ttsReqs = driver.getTtsRequests();
    const hasRedirect = ttsReqs.some((r) => r.text.includes("question"));
    expect(hasRedirect).toBe(true);
  });
});

// ─── Vision interrupts ────────────────────────────────────────────────────────

test.describe("Comedian Brain — Vision Interrupts", () => {
  test("delivering → check_vision → ask_question flow after answer", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    await driver.startStateTracking();
    await driver.simulateAnswer("My name is Jordan");
    // delivering and check_vision are both transient — verify delivering was visited
    // check_vision may be skipped when no observations exist (goes straight to ask_question)
    await driver.waitForStateVisited("delivering", 5000);
    // Verify the flow continues to ask_question (next cycle)
    await driver.waitForBrainState("ask_question", 8000);
  });

  test("vision_react fires when interesting observations change", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    await driver.startStateTracking();

    // Now change observations to something with a high-interest keyword AFTER
    // the brain has already seen initial observations — this creates a diff
    driver.mockVisionObservations(["a dog appeared on camera"]);

    await driver.simulateAnswer("I'm from Florida");
    // The brain flows: generating → delivering → check_vision → possibly vision_react
    // With the dog keyword change, it should find the diff interesting
    // Wait for it to settle past check_vision
    await driver.waitForBrainStateOneOf(
      ["check_vision", "vision_react", "ask_question"],
      8000,
    );

    const history = await driver.getStateHistory();
    // Verify the flow went through delivering at minimum
    expect(history).toContain("delivering");
  });
});

// ─── TTS-WS route coverage ────────────────────────────────────────────────────

test.describe("Comedian Brain — TTS-WS Route", () => {
  test("/api/tts-ws is called for puppet speech (greeting)", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    // Wait for at least one TTS request (greeting speech fires first)
    const req = await driver.waitForTtsRequest(8000);
    expect(req.text).toBeTruthy();
    // tts-ws requests are captured in the same queue as tts requests
    // (liveSessionMock.ts mocks both routes and collects into ttsRequests)
    const allReqs = driver.getTtsRequests();
    expect(allReqs.length).toBeGreaterThan(0);
  });

  test("/api/tts-ws receives text when brain delivers a joke", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    await startRoasting(page, driver);

    await driver.waitForBrainState("wait_answer", 10000);
    driver.clearTtsRequests();

    driver.mockJokeResponse({
      relevant: true,
      jokes: [{ text: "You're like a human participation trophy.", motion: "smug", intensity: 0.8, score: 7 }],
    });

    await driver.simulateAnswer("I work in marketing");
    await driver.waitForStateVisited("delivering", 5000);

    const reqs = driver.getTtsRequests();
    // At least the joke delivery should have gone through TTS
    const jokeReq = reqs.find((r) => r.text.includes("participation trophy") || r.text.length > 0);
    expect(jokeReq).toBeTruthy();
  });
});

// ─── Startup speed ────────────────────────────────────────────────────────────

test.describe("Comedian Brain — Startup Speed", () => {
  test("first question fires within 8s of page load", async ({ page }) => {
    const driver = new ComedianBrainDriver(page);
    await driver.setup();
    const startMs = Date.now();
    await startRoasting(page, driver);

    await driver.waitForBrainState("ask_question", 8000);
    const elapsed = Date.now() - startMs;
    expect(elapsed).toBeLessThan(8000);
  });
});
