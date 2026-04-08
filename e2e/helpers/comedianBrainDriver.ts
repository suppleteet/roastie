import type { Page } from "@playwright/test";
import { LiveSessionMock } from "./liveSessionMock";
import type { JokeResponse } from "@/app/api/generate-joke/route";
import type { BrainState } from "@/lib/comedianBrainConfig";

export type JokeApiRequest = {
  context: string;
  persona: string;
  burnIntensity: number;
  question?: string;
  userAnswer?: string;
  observations?: string[];
  previousObservations?: string[];
  conversationSoFar?: string[];
  imageBase64?: string;
};

const DEFAULT_JOKE_RESPONSE: JokeResponse = {
  relevant: true,
  jokes: [{ text: "You look like a lifestyle choice gone wrong.", motion: "smug", intensity: 0.8, score: 7 }],
};

/**
 * Extends LiveSessionMock with ComedianBrain-specific controls.
 *
 * Usage:
 *   const driver = new ComedianBrainDriver(page);
 *   await driver.setup();  // before page.goto()
 *   await page.goto("/");
 *   // ... navigate to roasting phase ...
 *   await driver.waitForConnect();
 *   await driver.waitForBrainState("wait_answer");
 *   await driver.simulateAnswer("My name is Mike");
 */
export class ComedianBrainDriver extends LiveSessionMock {
  private jokeRequests: JokeApiRequest[] = [];
  private jokeResponseQueue: Partial<JokeResponse>[] = [];
  private defaultJokeResponse: Partial<JokeResponse> = DEFAULT_JOKE_RESPONSE;

  constructor(page: Page) {
    super(page);
  }

  override async setup(): Promise<void> {
    await super.setup();
    await this._mockGenerateJokeRoute();
    await this._mockGenerateSpeakRoute();
    await this._injectSpeedConfig();
  }

  // ─── Config injection ────────────────────────────────────────────────────────

  /** Inject fast timing config so tests complete in ~seconds not minutes */
  private async _injectSpeedConfig(): Promise<void> {
    await this.page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__COMEDIAN_CONFIG__ = {
        answerWaitMs: 80,
        answerSilenceMs: 30,
        maxProds: 1,
        visionIntervalMs: 200,
        greetingVisionTimeoutMs: 300,
        hopperMaxSize: 4,
        confirmationEnabled: false, // E2E tests bypass mic — skip confirmation by default
      };
    });
  }

  // ─── Joke API mock ────────────────────────────────────────────────────────────

  private async _mockGenerateJokeRoute(): Promise<void> {
    await this.page.route("/api/generate-joke", async (route) => {
      const body = route.request().postDataJSON() as JokeApiRequest;
      this.jokeRequests.push(body);

      const response = this.jokeResponseQueue.shift() ?? this.defaultJokeResponse;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          relevant: true,
          jokes: [{ text: "Test joke.", motion: "smug", intensity: 0.7, score: 6 }],
          ...response,
        }),
      });
    });
  }

  private async _mockGenerateSpeakRoute(): Promise<void> {
    await this.page.route("/api/generate-speak", async (route) => {
      const body = route.request().postDataJSON() as JokeApiRequest;
      this.jokeRequests.push(body);

      const response = this.jokeResponseQueue.shift() ?? this.defaultJokeResponse;
      const full = {
        relevant: true,
        jokes: [{ text: "Test joke.", motion: "smug", intensity: 0.7, score: 6 }],
        ...response,
      };

      // Build SSE body
      const parts: string[] = [];
      if (full.relevant) {
        for (const joke of full.jokes ?? []) {
          parts.push(`data: ${JSON.stringify({ type: "joke", ...joke })}\n\n`);
        }
      }
      const meta: Record<string, unknown> = { type: "meta", relevant: full.relevant ?? true };
      if (full.followUp) meta.followUp = full.followUp;
      if (full.redirect) meta.redirect = full.redirect;
      if (full.tags) meta.tags = full.tags;
      if (full.callback) meta.callback = full.callback;
      parts.push(`data: ${JSON.stringify(meta)}\n\n`);
      parts.push(`data: ${JSON.stringify({ type: "done" })}\n\n`);

      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: parts.join(""),
      });
    });
  }

  // ─── Joke API control ─────────────────────────────────────────────────────────

  /** Override the next joke API response */
  mockJokeResponse(response: Partial<JokeResponse>): void {
    this.jokeResponseQueue = [response];
  }

  /** Queue a sequence of joke API responses */
  mockJokeResponseSequence(responses: Partial<JokeResponse>[]): void {
    this.jokeResponseQueue = [...responses];
  }

  /** Wait for the next /api/generate-joke request */
  async waitForJokeRequest(timeout = 5000): Promise<JokeApiRequest> {
    const startCount = this.jokeRequests.length;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.jokeRequests.length > startCount) {
        return this.jokeRequests.at(-1)!;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timeout waiting for joke API request (${timeout}ms)`);
  }

  getJokeRequests(): JokeApiRequest[] {
    return [...this.jokeRequests];
  }

  clearJokeRequests(): void {
    this.jokeRequests = [];
  }

  // ─── Brain state observation ──────────────────────────────────────────────────

  /** Start a MutationObserver on data-brain-state to record every state visited */
  async startStateTracking(): Promise<void> {
    await this.page.evaluate(() => {
      const el = document.querySelector("[data-testid='hud-overlay']");
      if (!el) return;
      const win = window as unknown as { __brainStateHistory__?: string[] };
      win.__brainStateHistory__ = [];
      const observer = new MutationObserver(() => {
        const state = el.getAttribute("data-brain-state") ?? "";
        if (state) {
          const history = (window as unknown as { __brainStateHistory__?: string[] }).__brainStateHistory__;
          if (history && history[history.length - 1] !== state) {
            history.push(state);
          }
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-brain-state"] });
    });
  }

  /** Get the full list of brain states visited since tracking started */
  async getStateHistory(): Promise<string[]> {
    return this.page.evaluate(() => {
      return (window as unknown as { __brainStateHistory__?: string[] }).__brainStateHistory__ ?? [];
    });
  }

  /** Poll data-brain-state attribute until it matches */
  async waitForBrainState(state: BrainState, timeout = 8000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await this.getBrainState();
      if (current === state) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    const current = await this.getBrainState();
    throw new Error(`Timeout waiting for brain state "${state}" (got "${current}")`);
  }

  /** Wait until a state has been visited at some point (even if transient) */
  async waitForStateVisited(state: BrainState, timeout = 8000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const history = await this.getStateHistory();
      if (history.includes(state)) return;
      // Also check current state (in case tracking started late)
      const current = await this.getBrainState();
      if (current === state) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    const history = await this.getStateHistory();
    throw new Error(`Timeout: brain never visited "${state}" (history: ${history.join(" → ")})`);
  }

  /** Wait until one of several states is current */
  async waitForBrainStateOneOf(states: BrainState[], timeout = 8000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await this.getBrainState();
      if (current && states.includes(current as BrainState)) return current;
      await new Promise((r) => setTimeout(r, 50));
    }
    const current = await this.getBrainState();
    throw new Error(`Timeout waiting for one of [${states.join(", ")}] (got "${current}")`);
  }

  async getBrainState(): Promise<string | null> {
    try {
      return await this.page.locator("[data-testid='hud-overlay']").getAttribute("data-brain-state", { timeout: 100 });
    } catch {
      return null; // HUD not in DOM (session ended or not yet started)
    }
  }

  // ─── Vision control ───────────────────────────────────────────────────────────

  mockVisionObservations(observations: string[]): void {
    // Override /api/analyze to return specific observations
    this.page.route("/api/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ observations, sentences: [] }),
      })
    );
  }

  // ─── User speech simulation ───────────────────────────────────────────────────

  /**
   * Simulate user speaking — injects inputTranscription word-by-word via WebSocket,
   * then waits for answer silence detection.
   */
  async simulateAnswer(text: string, wordDelayMs = 10): Promise<void> {
    // Send individual words as deltas (like real Gemini inputTranscription)
    const words = text.split(/\s+/);
    for (const word of words) {
      this.sendInputTranscription(word);
      await new Promise((r) => setTimeout(r, wordDelayMs));
    }
    // Wait for answerSilenceMs (30ms in fast config) + buffer for silence detection
    await new Promise((r) => setTimeout(r, 200));
  }

  // ─── Greeting control ─────────────────────────────────────────────────────────

  disableGeneratedGreetings(): void {
    this.jokeResponseQueue.unshift({ jokes: [] });
  }
}
