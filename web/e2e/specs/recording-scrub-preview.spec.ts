/**
 * Recording view scrub preview -- MEDIUM tier.
 *
 * Dragging the handlebar near the live edge must update the scrub preview
 * while the handle is still held, not only once it is dropped. The current
 * hour has no preview mp4 yet, so this exercises the cached frames player.
 */

import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";

// midday, so dragging back from the live edge never crosses midnight: the
// recording view only spans the current day
const NOW = new Date(2026, 8, 2, 12, 30, 0);
const playbackTime = Math.floor(NOW.getTime() / 1000) - 120;
const FRAME_INTERVAL_S = 2;

/** The newest cached frame served to the main camera, for assertions. */
let newestMainFrame = 0;

async function openRecordingView(
  frigateApp: FrigateApp,
  {
    frameIntervalS = FRAME_INTERVAL_S,
    framesStopBeforeEndS = 0,
    frameMissing = () => false,
  }: {
    frameIntervalS?: number;
    framesStopBeforeEndS?: number;
    // listed but gone from the cache, as after the hourly mp4 is written
    frameMissing?: (time: number) => boolean;
  } = {},
) {
  await frigateApp.page.route("**/api/*/recordings**", (route) =>
    route.fulfill({ json: [] }),
  );
  // a real server takes a moment to answer; an instant mock hides any
  // window where the timeline swaps to its loading skeleton
  await frigateApp.page.route(
    "**/api/review/activity/motion**",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fulfill({ json: [] });
    },
  );
  await frigateApp.page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
  await frigateApp.page.route("**/api/*/recordings/coverage**", (route) =>
    route.fulfill({
      json: {
        spans: [
          {
            start_time: playbackTime - 3600,
            end_time: playbackTime + 600,
            streams: ["main"],
          },
        ],
        timelines: Object.fromEntries(
          ["auto", "main", "sub"].map((key) => [
            key,
            [
              {
                start_time: playbackTime - 3600,
                end_time: playbackTime + 600,
                duration: 4200 * 1000,
              },
            ],
          ]),
        ),
        codecs_compatible: true,
        streams: {
          main: {
            video_codec: "h264",
            audio_rate: null,
            audio_codec: null,
            has_audio: false,
            bitrate: 2_000_000,
          },
        },
      },
    }),
  );

  // no hourly mp4 yet; serve a cached frame every few seconds for the
  // requested window, the same shape the frames endpoint returns
  await frigateApp.page.route(/\/api\/preview\/.+\/start\//, (route) => {
    const url = route.request().url();
    const match = url.match(/\/preview\/([^/]+)\/start\/(\d+)\/end\/(\d+)/);

    if (!url.includes("/frames") || !match) {
      return route.fulfill({ json: [] });
    }

    const [, camera, start, end] = match;
    // the page clock runs ahead of this process once fast-forwarded, so
    // cover the whole requested window instead of clamping to real now
    const frames: string[] = [];
    const last = Number(end) - framesStopBeforeEndS;
    for (let t = Number(start); t <= last; t += frameIntervalS) {
      frames.push(`preview_${camera}-${t}.webp`);
      if (camera == "front_door") {
        newestMainFrame = t;
      }
    }
    return route.fulfill({ json: frames });
  });

  await frigateApp.page.route("**/thumbnail.webp", (route) => {
    const time = Number(
      route
        .request()
        .url()
        .match(/preview_front_door-([\d.]+)\.webp/)?.[1],
    );
    return frameMissing(time)
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ contentType: "image/png", body: PLACEHOLDER_PNG });
  });

  await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);
}

/**
 * The move listener is attached on the render after the press; a move sent
 * sooner (no hand is that fast) would be lost, so wait for the drag state.
 */
async function waitForDragStart(page: FrigateApp["page"]) {
  await expect(
    page.locator('[role="scrollbar"] .cursor-grabbing').first(),
  ).toBeAttached();
}

/** Drags the handlebar down in steps, asserting each step lands a new frame. */
async function dragHandlebarExpectingFrames(
  frigateApp: FrigateApp,
  { tickWhileHeld = false }: { tickWhileHeld?: boolean } = {},
) {
  const page = frigateApp.page;
  const handle = page.locator('[role="scrollbar"] .rounded-full').first();
  await expect(handle).toBeVisible({ timeout: 15_000 });
  // the scrub preview is driven through the main player's controller,
  // which only exists once the player has a source to mount
  await expect(page.locator("video").first()).toBeAttached({
    timeout: 15_000,
  });
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("handlebar has no bounding box");
  }

  // the main camera's scrub preview, not the tiles beside it
  const mainFrame = () =>
    page.evaluate(
      () =>
        Array.from(document.querySelectorAll("img"))
          .map((img) => img.getAttribute("src") ?? "")
          .find((src) => src.includes("preview_front_door-")) ?? "",
    );

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await waitForDragStart(page);
  let previous = await mainFrame();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(x, y + i * 30, { steps: 3 });
    // still held: the frame has to change before the release
    await expect.poll(mainFrame, { timeout: 3_000 }).not.toBe(previous);
    previous = await mainFrame();

    if (tickWhileHeld && i == 2) {
      // a liveEdgeBefore tick mid-drag used to swap the timeline to its
      // skeleton while the slow refetch landed, dropping the handle; wait
      // for that response (if the tick refetches) before moving on
      const refetched = page
        .waitForResponse(/\/api\/review\/activity\/motion/, {
          timeout: 3_000,
        })
        .catch(() => undefined);
      await page.clock.fastForward("00:20");
      await refetched;
    }
  }
  await page.mouse.up();
}

async function runScrubCase(
  frigateApp: FrigateApp,
  {
    afterLiveEdgeGrows,
    tickWhileHeld = false,
  }: { afterLiveEdgeGrows: boolean; tickWhileHeld?: boolean },
) {
  // a controllable clock lets the live edge tick without a real wait
  await frigateApp.page.clock.install({ time: NOW });
  await frigateApp.installDefaults();
  await openRecordingView(frigateApp);

  if (afterLiveEdgeGrows) {
    // mounted first, or the view just opens later; then past at least
    // one liveEdgeBefore tick (runFor fires each one, fastForward only once)
    await expect(
      frigateApp.page.locator('[role="scrollbar"] .rounded-full').first(),
    ).toBeVisible({ timeout: 15_000 });
    await frigateApp.page.clock.runFor("00:35");
  }

  await dragHandlebarExpectingFrames(frigateApp, { tickWhileHeld });
}

test.describe("Recording scrub preview: desktop @medium", () => {
  test("scrub preview follows the handlebar while it is held", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    await runScrubCase(frigateApp, { afterLiveEdgeGrows: false });
  });

  test("scrub preview still follows the handlebar after the live edge grows", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    await runScrubCase(frigateApp, { afterLiveEdgeGrows: true });
  });

  test("a live edge tick while the handlebar is held does not drop it", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    await runScrubCase(frigateApp, {
      afterLiveEdgeGrows: false,
      tickWhileHeld: true,
    });
  });
});

test.describe("Recording scrub preview past the newest frame: desktop @medium", () => {
  test("scrubbing past the newest cached frame shows that frame", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    const page = frigateApp.page;
    await page.clock.install({ time: NOW });
    await frigateApp.installDefaults();
    // a still scene only caches a frame every 30s, so the newest one can be
    // well behind the live edge
    await openRecordingView(frigateApp, {
      frameIntervalS: 10,
      framesStopBeforeEndS: 40,
    });

    const handle = page.locator('[role="scrollbar"] .rounded-full').first();
    await expect(handle).toBeVisible({ timeout: 15_000 });

    // the handle stops 1.5 segments below the top of the track, which at
    // the default 30s zoom is still before the newest frame; zoom in to
    // 5s segments so the top of its range is past it
    const zoomIn = page.locator("div.absolute.z-30 > button").nth(1);
    for (let i = 0; i < 2; i++) {
      await zoomIn.click();
    }
    await expect(zoomIn).toBeDisabled();

    const box = await handle.boundingBox();
    if (!box) {
      throw new Error("handlebar has no bounding box");
    }

    // one move straight to the top of the track, past the newest frame
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await waitForDragStart(page);
    await page.mouse.move(x, 5);

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll("img"))
              .map((img) => img.getAttribute("src") ?? "")
              .find((src) => src.includes("preview_front_door-")) ?? "",
        ),
      )
      .toContain(`preview_front_door-${newestMainFrame}.webp`);
    await page.mouse.up();
  });
});

test.describe("Recording scrub preview hold: desktop @medium", () => {
  test("the preview catches up when the handle stops moving", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    const page = frigateApp.page;
    await page.clock.install({ time: NOW });
    await frigateApp.installDefaults();
    await openRecordingView(frigateApp);

    const handle = page.locator('[role="scrollbar"] .rounded-full').first();
    await expect(handle).toBeVisible({ timeout: 15_000 });
    const box = await handle.boundingBox();
    if (!box) {
      throw new Error("handlebar has no bounding box");
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await waitForDragStart(page);

    // two moves inside one 100ms commit window: the first lands, the
    // second is held back, then the handle sits still past the window
    await page.mouse.move(x, y + 20);
    await page.mouse.move(x, y + 300);
    await page.clock.runFor(300);

    // the handle's own label follows the pointer every frame, though only
    // to its segment
    const handleTime = await page.evaluate(() => {
      const label =
        document.querySelector('[role="scrollbar"] .rounded-full > div')
          ?.textContent ?? "";
      return Date.parse(`${new Date().toDateString()} ${label}`) / 1000;
    });
    expect(handleTime).not.toBeNaN();

    const shownFrameTime = () =>
      page.evaluate(() => {
        const src =
          Array.from(document.querySelectorAll("img"))
            .map((img) => img.getAttribute("src") ?? "")
            .find((s) => s.includes("preview_front_door-")) ?? "";
        return Number(src.match(/preview_front_door-(\d+)\.webp/)?.[1] ?? 0);
      });

    // within one 30s segment of the label; a held-back value would still
    // show the first move, minutes away
    await expect
      .poll(async () => Math.abs((await shownFrameTime()) - handleTime))
      .toBeLessThanOrEqual(30);
    await page.mouse.up();
  });
});

test.describe("Recording live edge: desktop @medium", () => {
  test("the live edge keeps growing after the handlebar is released", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    const page = frigateApp.page;
    let latestBefore = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (/\/api\/[^/]+\/recordings\/coverage$/.test(url.pathname)) {
        latestBefore = Math.max(
          latestBefore,
          Number(url.searchParams.get("before") ?? 0),
        );
      }
    });

    await page.clock.install({ time: NOW });
    await frigateApp.installDefaults();
    await openRecordingView(frigateApp);

    // the view has to be mounted before the clock moves, or it simply
    // opens a minute later and the window below starts from there
    await expect(
      page.locator('[role="scrollbar"] .rounded-full').first(),
    ).toBeVisible({ timeout: 15_000 });

    // past the first minute: releasing a drag restarts the live edge
    // interval, and a restart after that used to stop it for good.
    // runFor fires every tick in the window, unlike fastForward
    await page.clock.runFor("01:05");
    await dragHandlebarExpectingFrames(frigateApp);

    // ticks after the release put the edge at "now" minus the 15s ingest
    // lag, so three of them carry it well past the release time; a frozen
    // edge stays behind it even after rounding up to a timeline segment
    const releasedAt = await page.evaluate(() => Date.now() / 1000);
    await page.clock.runFor("00:50");
    await expect
      .poll(() => latestBefore)
      .toBeGreaterThanOrEqual(releasedAt + 20);
  });
});

test.describe("Recording scrub preview: mobile @medium @mobile", () => {
  test("scrub preview follows the handlebar while it is held", async ({
    frigateApp,
  }) => {
    if (!frigateApp.isMobile) {
      test.skip();
      return;
    }

    await runScrubCase(frigateApp, { afterLiveEdgeGrows: true });
  });
});

test.describe("Recording scrub preview missing frames: desktop @medium", () => {
  test("a frame that fails to load doesn't freeze the scrub preview", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    const page = frigateApp.page;
    await page.clock.install({ time: NOW });
    await frigateApp.installDefaults();
    // a band of frames behind the playhead is listed but gone
    const missing = (time: number) =>
      time < playbackTime - 60 && time > playbackTime - 200;
    let missingFrameFailed = false;
    page.on("requestfinished", (request) => {
      const time = Number(
        request.url().match(/preview_front_door-([\d.]+)\.webp/)?.[1],
      );
      if (missing(time)) {
        missingFrameFailed = true;
      }
    });
    await openRecordingView(frigateApp, { frameMissing: missing });

    const handle = page.locator('[role="scrollbar"] .rounded-full').first();
    await expect(handle).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("video").first()).toBeAttached({
      timeout: 15_000,
    });
    const box = await handle.boundingBox();
    if (!box) {
      throw new Error("handlebar has no bounding box");
    }

    const mainFrame = () =>
      page.evaluate(() => {
        const img = Array.from(document.querySelectorAll("img")).find((img) =>
          (img.getAttribute("src") ?? "").includes("preview_front_door-"),
        );
        return {
          time: Number(
            img?.getAttribute("src")?.match(/preview_front_door-([\d.]+)/)?.[1],
          ),
          loaded: !!img && img.complete && img.naturalWidth > 0,
        };
      });

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await waitForDragStart(page);

    // into the missing band (30px is about 110s at the default zoom)
    await page.mouse.move(x, y + 30, { steps: 3 });
    await expect.poll(() => missingFrameFailed).toBe(true);

    // and out the other side: the preview follows again
    await page.mouse.move(x, y + 90, { steps: 3 });
    await expect
      .poll(async () => (await mainFrame()).time, { timeout: 3_000 })
      .toBeLessThan(playbackTime - 200);
    await expect.poll(async () => (await mainFrame()).loaded).toBe(true);
    await page.mouse.up();
  });
});
