import type { Page } from "@playwright/test";
import { LiveSessionMock } from "./liveSessionMock";
import type { BrainState } from "@/lib/comedianBrainConfig";

/**
 * Extends LiveSessionMock with brain-observation helpers, but does NOT mock
 * /api/generate-joke, /api/generate-speak, /api/generate-question.
 *
 * Use for end-to-end tests that exercise real LLM joke generation. Vision and
 * TTS remain mocked via LiveSessionMock.
 */
export class RealLlmDriver extends LiveSessionMock {
  constructor(page: Page) {
    super(page);
  }

  override async setup(): Promise<void> {
    await super.setup();
  }

  // ─── Brain state observation ──────────────────────────────────────────────────

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

  async getStateHistory(): Promise<string[]> {
    return this.page.evaluate(() => {
      return (window as unknown as { __brainStateHistory__?: string[] }).__brainStateHistory__ ?? [];
    });
  }

  async getBrainState(): Promise<string | null> {
    try {
      return await this.page.locator("[data-testid='hud-overlay']").getAttribute("data-brain-state", { timeout: 100 });
    } catch {
      return null;
    }
  }

  async waitForBrainState(state: BrainState, timeout = 30_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await this.getBrainState();
      if (current === state) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const current = await this.getBrainState();
    throw new Error(`Timeout waiting for brain state "${state}" (got "${current}")`);
  }

  async waitForBrainStateOneOf(states: BrainState[], timeout = 15_000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await this.getBrainState();
      if (current && states.includes(current as BrainState)) return current;
      await new Promise((r) => setTimeout(r, 100));
    }
    const current = await this.getBrainState();
    throw new Error(`Timeout waiting for one of [${states.join(", ")}] (got "${current}")`);
  }

  /** Read the current question text from the HUD overlay's data attribute. */
  async getCurrentQuestion(): Promise<string | null> {
    try {
      const value = await this.page
        .locator("[data-testid='hud-overlay']")
        .getAttribute("data-current-question", { timeout: 100 });
      return value && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
}
