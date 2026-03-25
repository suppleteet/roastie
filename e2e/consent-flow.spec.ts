import { test, expect } from "@playwright/test";

// debugMode is true by default in page.tsx, so the app auto-starts into roasting phase.
// These tests mock the APIs needed for that flow to succeed.

test.beforeEach(async ({ page }) => {
  // Fake webcam + mic so getUserMedia succeeds
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, 640, 480);

    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    // @ts-ignore
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && !constraints?.video) {
        const audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        return dest.stream;
      }
      const videoStream = (canvas as any).captureStream(5);
      if (constraints?.audio) {
        const audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        return new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      }
      return videoStream;
    };
  });
});

test("app loads and reaches roasting phase (debug auto-start)", async ({ page }) => {
  await page.route("/api/live-token", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-token" }) })
  );
  await page.route("/api/analyze", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ observations: [], sentences: [] }) })
  );
  await page.routeWebSocket("wss://generativelanguage.googleapis.com/**", (ws) => {
    ws.onMessage((data) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as Buffer).toString());
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      } catch { /* binary frame */ }
    });
  });

  await page.goto("/");
  await expect(page.locator("[data-testid='hud-overlay']")).toBeVisible({ timeout: 10000 });
});

test("debug checkbox toggles back to landing screen", async ({ page }) => {
  await page.route("/api/live-token", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-token" }) })
  );
  await page.route("/api/analyze", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ observations: [], sentences: [] }) })
  );
  await page.routeWebSocket("wss://generativelanguage.googleapis.com/**", (ws) => {
    ws.onMessage((data) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as Buffer).toString());
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      } catch { /* binary frame */ }
    });
  });

  await page.goto("/");
  await expect(page.locator("[data-testid='hud-overlay']")).toBeVisible({ timeout: 10000 });

  // Uncheck debug → should return to idle/landing
  await page.locator("input[type=checkbox]").uncheck();
  await expect(page.getByRole("button", { name: /roast me/i })).toBeVisible({ timeout: 5000 });
});

test("landing Roast Me button starts a session", async ({ page }) => {
  await page.route("/api/live-token", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-token" }) })
  );
  await page.route("/api/analyze", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ observations: [], sentences: [] }) })
  );
  await page.routeWebSocket("wss://generativelanguage.googleapis.com/**", (ws) => {
    ws.onMessage((data) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as Buffer).toString());
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      } catch { /* binary frame */ }
    });
  });

  await page.goto("/");
  // Disable debug to get to landing screen
  await expect(page.locator("[data-testid='hud-overlay']")).toBeVisible({ timeout: 10000 });
  await page.locator("input[type=checkbox]").uncheck();
  await expect(page.getByRole("button", { name: /roast me/i })).toBeVisible({ timeout: 5000 });

  // Click Roast Me → goes directly to requesting-permissions → session starts
  await page.getByRole("button", { name: /roast me/i }).click();
  await expect(page.locator("[data-testid='hud-overlay']")).toBeVisible({ timeout: 10000 });
});
