/**
 * Recording view scrub preview -- MEDIUM tier.
 *
 * Dragging the handlebar near the live edge must update the scrub preview
 * while the handle is still held, not only once it is dropped. The current
 * hour has no preview mp4 yet, so this exercises the cached frames player.
 */

import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";

const playbackTime = Math.floor(Date.now() / 1000) - 120;
const FRAME_INTERVAL_S = 2;

async function openRecordingView(frigateApp: FrigateApp) {
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
    for (let t = Number(start); t <= Number(end); t += FRAME_INTERVAL_S) {
      frames.push(`preview_${camera}-${t}.webp`);
    }
    return route.fulfill({ json: frames });
  });

  await frigateApp.page.route("**/thumbnail.webp", (route) =>
    route.fulfill({ contentType: "image/png", body: PLACEHOLDER_PNG }),
  );

  await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);
}

/** Drags the handlebar down in steps, asserting each step lands a new frame. */
async function dragHandlebarExpectingFrames(
  frigateApp: FrigateApp,
  { tickWhileHeld = false }: { tickWhileHeld?: boolean } = {},
) {
  const page = frigateApp.page;
  const handle = page.locator('[role="scrollbar"] .rounded-full').first();
  await expect(handle).toBeVisible({ timeout: 15_000 });
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
  let previous = await mainFrame();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(x, y + i * 30, { steps: 3 });
    // still held: the frame has to change before the release
    await expect.poll(mainFrame, { timeout: 3_000 }).not.toBe(previous);
    previous = await mainFrame();

    if (tickWhileHeld && i == 2) {
      // a liveEdgeBefore tick mid-drag used to rebuild the timeline and
      // drop the handle, so the remaining steps stopped moving it
      // if a tick does refetch, let the slow response land before moving
      // on, since that is when the timeline used to swap to its skeleton
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
  await frigateApp.page.clock.install();
  await frigateApp.installDefaults();
  await openRecordingView(frigateApp);

  if (afterLiveEdgeGrows) {
    // past at least one liveEdgeBefore tick
    await frigateApp.page.clock.fastForward("00:35");
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
