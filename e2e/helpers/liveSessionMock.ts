import type { Page, WebSocketRoute } from "@playwright/test";

type ServerMessage = Record<string, unknown>;
export type TtsRequest = { text: string; voiceId?: string; voiceSettings?: unknown };

// ─── Minimal silent WAV ───────────────────────────────────────────────────────
// AudioContext.decodeAudioData needs a valid encoded file — empty buffer throws.
// 50ms of silence at 22050 Hz is small and always decodeable.
function silentWav(): Buffer {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * 0.05); // 50ms
  const dataBytes = numSamples * 2; // 16-bit
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  buf.fill(0, 44);
  return buf;
}

// ─── LiveSessionMock ──────────────────────────────────────────────────────────

/**
 * Test double for the Gemini Live WebSocket + ElevenLabs TTS.
 *
 * Usage:
 *   const mock = new LiveSessionMock(page);
 *   await mock.setup();            // before page.goto()
 *   await page.goto("/");
 *   // ... navigate to roasting phase ...
 *   await mock.waitForConnect();   // wait for Gemini WS handshake
 *   mock.sendOutputTranscription("Your hair is a disaster.");
 *   mock.sendTurnComplete();
 *   const req = await mock.waitForTtsRequest();
 *   expect(req.text).toContain("disaster");
 */
export interface LiveSessionMockOptions {
  /** If true, the mock auto-responds to the "Go!" kickoff with a roast sentence.
   *  Enable only for startup-speed tests — leave off for pipeline tests that call clearTtsRequests(). */
  autoRespondToKickoff?: boolean;
}

export class LiveSessionMock {
  private ws: WebSocketRoute | null = null;
  private connectResolvers: Array<() => void> = [];
  private ttsRequests: TtsRequest[] = [];
  private ttsWaiters: Array<(req: TtsRequest) => void> = [];

  /** Raw JSON strings the app sent to Gemini — useful for debugging. */
  readonly clientMessages: string[] = [];

  constructor(
    protected readonly page: Page,
    private readonly options: LiveSessionMockOptions = {},
  ) {}

  // ─── Setup ──────────────────────────────────────────────────────────────────

  /**
   * Install all mocks. Must be called before page.goto().
   *
   * Mocks installed:
   *   - navigator.mediaDevices.getUserMedia → silent audio + fake canvas video
   *   - /api/live-token → fake ephemeral token
   *   - /api/analyze   → empty observations (optional, prevents real API calls)
   *   - /api/tts       → silent WAV (decodeable by AudioContext)
   *   - Gemini Live WebSocket → intercepts connection, handles handshake
   */
  async setup(): Promise<void> {
    await this._mockBrowserApis();
    await this._mockHttpRoutes();
    await this._mockGeminiWebSocket();
  }

  private async _mockBrowserApis(): Promise<void> {
    await this.page.addInitScript(() => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const wantsAudio = !!constraints?.audio;
        const wantsVideo = !!constraints?.video;

        // Silent audio stream
        const makeAudio = () => {
          const ctx = new AudioContext();
          const dest = ctx.createMediaStreamDestination();
          const osc = ctx.createOscillator();
          osc.frequency.value = 0;
          osc.connect(dest);
          osc.start();
          return dest.stream;
        };

        // Fake black canvas stream
        const makeVideo = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 480;
          const ctx2d = canvas.getContext("2d")!;
          ctx2d.fillStyle = "#222";
          ctx2d.fillRect(0, 0, 640, 480);
          return (canvas as unknown as { captureStream(fps: number): MediaStream }).captureStream(5);
        };

        if (wantsVideo && wantsAudio) {
          const v = makeVideo();
          const a = makeAudio();
          return new MediaStream([...v.getVideoTracks(), ...a.getAudioTracks()]);
        }
        if (wantsAudio) return makeAudio();
        if (wantsVideo) return makeVideo();
        return orig(constraints);
      };
    });
  }

  private async _mockHttpRoutes(): Promise<void> {
    await this.page.route("/api/live-token", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-ephemeral-token" }),
      })
    );

    await this.page.route("/api/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ observations: [], sentences: [] }),
      })
    );

    await this.page.route("/api/tts", async (route) => {
      const body = route.request().postDataJSON() as TtsRequest;
      const req: TtsRequest = { text: body.text, voiceId: body.voiceId, voiceSettings: body.voiceSettings };
      this.ttsRequests.push(req);
      for (const resolve of this.ttsWaiters.splice(0)) resolve(req);
      await route.fulfill({
        status: 200,
        contentType: "audio/mpeg", // ElevenLabs returns audio/mpeg; WAV decodes regardless
        body: silentWav(),
      });
    });
  }

  private async _mockGeminiWebSocket(): Promise<void> {
    await this.page.routeWebSocket(
      "wss://generativelanguage.googleapis.com/**",
      (ws) => {
        this.ws = ws;
        for (const resolve of this.connectResolvers.splice(0)) resolve();

        ws.onMessage((data) => {
          // Playwright delivers string or Buffer
          const raw =
            typeof data === "string"
              ? data
              : Buffer.from(data as Buffer).toString("utf-8");
          this.clientMessages.push(raw);

          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            // Respond to SDK setup handshake so session.onopen fires
            if (parsed.setup) {
              ws.send(JSON.stringify({ setupComplete: {} }));
            }
            // Auto-respond to "Go!" kickoff — only when explicitly requested by the test.
            if (this.options.autoRespondToKickoff) {
              const clientContent = parsed.clientContent as { turns?: Array<{ role: string; parts?: Array<{ text?: string }> }>; turnComplete?: boolean } | undefined;
              const isKickoff = clientContent?.turns?.some((t) =>
                t.parts?.some((p) => p.text?.trim().toLowerCase() === "go!")
              );
              if (isKickoff) {
                setTimeout(() => {
                  ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: "Oh, where do I even begin with you? " } } }));
                  ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
                }, 150);
              }
            }
          } catch {
            // Non-JSON binary frame (e.g. protobuf audio chunk) — ignore
          }
        });
      }
    );
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Resolves when the app establishes the Gemini WebSocket (after setup handshake).
   * Call this after navigating to the roasting phase.
   */
  waitForConnect(timeout = 10_000): Promise<void> {
    if (this.ws) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.connectResolvers.push(resolve);
      setTimeout(
        () => reject(new Error("Timeout waiting for Gemini WebSocket connect")),
        timeout
      );
    });
  }

  // ─── Sending server messages ─────────────────────────────────────────────────

  /** Send a raw Gemini Live server message to the app. */
  send(msg: ServerMessage): void {
    if (!this.ws) throw new Error("WebSocket not connected — call waitForConnect() first");
    this.ws.send(JSON.stringify(msg));
  }

  /** Simulate Gemini transcribing its own audio output (the text the puppet is saying). */
  sendOutputTranscription(text: string): void {
    this.send({ serverContent: { outputTranscription: { text } } });
  }

  /** Simulate the model finishing its turn. */
  sendTurnComplete(): void {
    this.send({ serverContent: { turnComplete: true } });
  }

  /** Simulate user speech interrupting the model (barge-in). */
  sendInterrupted(): void {
    this.send({ serverContent: { interrupted: true } });
  }

  /** Simulate Gemini transcribing user speech. */
  sendInputTranscription(text: string): void {
    this.send({ serverContent: { inputTranscription: { text } } });
  }

  /** Simulate a GoAway message (session about to expire). */
  sendGoAway(timeLeftSeconds = 10): void {
    this.send({ goAway: { timeLeft: { seconds: timeLeftSeconds } } });
  }

  /**
   * Simulate a full model turn: send text as individual transcription chunks,
   * then fire turnComplete. Mirrors how Gemini streams in production.
   */
  sendModelTurn(sentences: string[]): void {
    for (const sentence of sentences) {
      this.sendOutputTranscription(sentence + " ");
    }
    this.sendTurnComplete();
  }

  // ─── TTS assertions ──────────────────────────────────────────────────────────

  getTtsRequests(): TtsRequest[] {
    return [...this.ttsRequests];
  }

  clearTtsRequests(): void {
    this.ttsRequests = [];
  }

  /**
   * Resolves with the next TTS request that arrives, or the most recent one
   * if requests have already been received since the last clear.
   */
  waitForTtsRequest(timeout = 8_000): Promise<TtsRequest> {
    return new Promise((resolve, reject) => {
      if (this.ttsRequests.length > 0) {
        resolve(this.ttsRequests.at(-1)!);
        return;
      }
      this.ttsWaiters.push(resolve);
      setTimeout(
        () => reject(new Error("Timeout waiting for TTS request — check console for Gemini client messages")),
        timeout
      );
    });
  }

  /** Waits until at least `count` TTS requests have been received. */
  async waitForTtsCount(count: number, timeout = 10_000): Promise<TtsRequest[]> {
    const deadline = Date.now() + timeout;
    while (this.ttsRequests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timeout: expected ${count} TTS requests, got ${this.ttsRequests.length}. ` +
          `Client messages: ${this.clientMessages.length}`
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return [...this.ttsRequests];
  }

  // ─── Client message inspection ───────────────────────────────────────────────

  /** Parse and return a message the app sent to Gemini. Negative index counts from end. */
  getClientMessage(index = -1): unknown {
    const idx = index < 0 ? this.clientMessages.length + index : index;
    const raw = this.clientMessages[idx];
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  /** Find the first client message matching a predicate. */
  findClientMessage(pred: (msg: unknown) => boolean): unknown {
    for (const raw of this.clientMessages) {
      try {
        const parsed = JSON.parse(raw);
        if (pred(parsed)) return parsed;
      } catch { /* skip binary */ }
    }
    return null;
  }
}
