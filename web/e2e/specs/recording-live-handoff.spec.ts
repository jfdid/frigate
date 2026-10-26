/**
 * Recording view live mode -- MEDIUM tier.
 *
 * At the live edge, releasing the handlebar at the top of the timeline
 * swaps the recording player for the camera's live stream inside the same
 * view. Dragging the handle back down, or tapping the timeline, returns to
 * recordings. go2rtc's MSE socket is mocked and streams a real fragmented
 * MP4, so the live player actually plays.
 */

import type { Page } from "@playwright/test";
import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";
import {
  LIVE_STREAM_CONFIG,
  mockLiveStream,
} from "../helpers/live-stream-mocker";

// midday, so the recording view's day never crosses midnight
const NOW = new Date(2026, 8, 2, 12, 30, 0);
const playbackTime = Math.floor(NOW.getTime() / 1000) - 120;

async function openAtLiveEdge(frigateApp: FrigateApp) {
  const page = frigateApp.page;

  await page.clock.install({ time: NOW });
  await frigateApp.installDefaults({ config: LIVE_STREAM_CONFIG });
  const stream = await mockLiveStream(page);

  await page.route("**/api/*/recordings**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/review/activity/motion**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/*/recordings/coverage**", (route) =>
    route.fulfill({
      json: {
        spans: [
          {
            start_time: playbackTime - 3600,
            end_time: playbackTime + 100,
            streams: ["main"],
          },
        ],
        timelines: Object.fromEntries(
          ["auto", "main", "sub"].map((key) => [
            key,
            [
              {
                start_time: playbackTime - 3600,
                end_time: playbackTime + 100,
                duration: 3700 * 1000,
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
  await page.route(/\/api\/preview\/.+\/start\//, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/thumbnail.webp", (route) =>
    route.fulfill({ contentType: "image/png", body: PLACEHOLDER_PNG }),
  );

  await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);

  await expect(handleLocator(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("video").first()).toBeAttached({
    timeout: 15_000,
  });

  return stream;
}

const handleLocator = (page: Page) =>
  page.locator('[role="scrollbar"] .rounded-full').first();
const hotZone = (page: Page) => page.getByTestId("live-hot-zone");
const livePlayer = (page: Page) => page.getByTestId("recording-live-player");
const activeLivePlayer = (page: Page) =>
  page.locator('[data-testid="recording-live-player"][data-active="true"]');

/** Where the handle is, and the top of the timeline's scroll container. */
async function measure(page: Page) {
  const handle = handleLocator(page);
  // the timeline scrolls the handle into view after loading and after a
  // release; a press measured mid-scroll lands beside the handle
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await handle.boundingBox());
      const settled = now == last;
      last = now;
      return settled;
    })
    .toBe(true);
  const box = await handle.boundingBox();
  // [role="scrollbar"] is the handlebar's own wrapper and moves with it
  const trackTop = await handle.evaluate(
    (el) => el.closest(".overflow-y-auto")?.getBoundingClientRect().top,
  );

  if (!box || trackTop === undefined) {
    throw new Error("handlebar or timeline has no bounding box");
  }

  return { x: box.x + box.width / 2, y: box.y + box.height / 2, trackTop };
}

/** Presses the handlebar and waits until the drag is live. */
async function grabHandle(page: Page) {
  const at = await measure(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  // the move listener is attached on the render after the press
  await expect(
    page.locator('[role="scrollbar"] .cursor-grabbing').first(),
  ).toBeAttached();
  return at;
}

/** Drags the handle to the top, checks the warm-up, and releases there. */
async function goLiveByDrag(page: Page) {
  const { x, trackTop } = await grabHandle(page);
  await page.mouse.move(x, trackTop - 20, { steps: 8 });
  await expect(hotZone(page)).toBeVisible();
  // connecting while the handle is still held
  await expect(livePlayer(page)).toBeAttached();
  await expect(livePlayer(page)).toHaveAttribute("data-active", "false");
  await page.mouse.up();
  await expect(activeLivePlayer(page)).toBeVisible();
}

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Recording live mode: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("releasing the handle at the top plays live in the same view", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await openAtLiveEdge(frigateApp);

      await goLiveByDrag(page);
      await expect(page).toHaveURL(/\/review/);
      await expect(page.getByText("Loading live stream…")).toBeVisible();

      stream.release();
      await expect(activeLivePlayer(page)).toHaveAttribute(
        "data-ready",
        "true",
      );
      await expect(page.getByText("Loading live stream…")).toBeHidden();
      // the handle says live rather than a time that lags the picture
      await expect(page.getByTestId("handlebar-label")).toHaveText("Live");
      // started with sound
      await expect
        .poll(() =>
          activeLivePlayer(page)
            .locator("video")
            .evaluate((video: HTMLVideoElement) => video.muted),
        )
        .toBe(false);
      // the timeline is still there to scrub back
      await expect(handleLocator(page)).toBeVisible();
    });

    test("releasing the handle lower keeps playing recordings", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await openAtLiveEdge(frigateApp);
      const { x, y } = await grabHandle(page);

      await page.mouse.move(x, y + 80, { steps: 8 });
      await expect(hotZone(page)).toBeHidden();
      await page.mouse.up();

      await expect(activeLivePlayer(page)).toHaveCount(0);
    });

    test("leaving the hot zone before the release cancels going live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await openAtLiveEdge(frigateApp);
      const { x, y, trackTop } = await grabHandle(page);

      await page.mouse.move(x, trackTop - 20, { steps: 8 });
      await expect(hotZone(page)).toBeVisible();
      await page.mouse.move(x, y + 80, { steps: 8 });
      await expect(hotZone(page)).toBeHidden();
      await page.mouse.up();

      await expect(activeLivePlayer(page)).toHaveCount(0);
    });

    test("dragging the handle down leaves live for recordings", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await openAtLiveEdge(frigateApp);
      stream.release();
      await goLiveByDrag(page);

      const { x, y } = await grabHandle(page);
      await page.mouse.move(x, y + 80, { steps: 8 });
      // scrubbing recordings again while the handle is still held
      await expect(activeLivePlayer(page)).toHaveCount(0);
      await expect(page.getByTestId("handlebar-label")).toHaveCount(0);
      await page.mouse.up();

      await expect(activeLivePlayer(page)).toHaveCount(0);
      await expect(handleLocator(page)).toBeVisible();
    });

    test("a live handle released without dragging it away stays live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await openAtLiveEdge(frigateApp);
      stream.release();
      await goLiveByDrag(page);

      const { x, y } = await grabHandle(page);
      await page.mouse.move(x, y + 3, { steps: 2 });
      await page.mouse.up();

      await expect(activeLivePlayer(page)).toBeVisible();
    });

    test("tapping the timeline leaves live for recordings", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await openAtLiveEdge(frigateApp);
      stream.release();
      await goLiveByDrag(page);

      const { x, y } = await measure(page);
      await page.mouse.click(x, y + 150);

      await expect(activeLivePlayer(page)).toHaveCount(0);
    });

    test("the live stream shows controls with a fullscreen button", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await openAtLiveEdge(frigateApp);
      stream.release();
      await goLiveByDrag(page);

      const controls = page.getByTestId("live-controls");
      await expect(controls).toBeHidden();

      // hover on desktop, a tap on touch devices
      if (mobile) {
        await activeLivePlayer(page).tap();
      } else {
        await activeLivePlayer(page).hover();
      }

      await expect(controls).toBeVisible();
      await page.getByTestId("live-fullscreen").click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement != null))
        .toBe(true);
      // still live, now fullscreen
      await expect(activeLivePlayer(page)).toBeVisible();
    });
  });
}

test.describe("Recording live mode: desktop extras @medium", () => {
  test.beforeEach(({ frigateApp }) => {
    test.skip(frigateApp.isMobile);
  });

  test("a touch drag released at the top goes live", async ({ frigateApp }) => {
    const page = frigateApp.page;
    await openAtLiveEdge(frigateApp);
    const handle = handleLocator(page);
    const box = await handle.boundingBox();
    const { trackTop } = await measure(page);

    if (!box) {
      throw new Error("handlebar has no bounding box");
    }

    // real touch events, the way a touchscreen drives the handle
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    const touch = (type: string, y: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type == "touchEnd" ? [] : [{ x: box.x + box.width / 2, y }],
      });

    await touch("touchStart", box.y + box.height / 2);
    await expect(
      page.locator('[role="scrollbar"] .cursor-grabbing').first(),
    ).toBeAttached();
    for (let y = box.y; y > trackTop - 20; y -= 15) {
      await touch("touchMove", y);
    }
    await touch("touchMove", trackTop - 20);
    await expect(hotZone(page)).toBeVisible();

    await touch("touchEnd", trackTop - 20);
    await expect(activeLivePlayer(page)).toBeVisible();
    await expect(page).toHaveURL(/\/review/);
  });

  test("the live stream zooms with the scroll wheel", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    const stream = await openAtLiveEdge(frigateApp);
    stream.release();
    await goLiveByDrag(page);
    await expect(activeLivePlayer(page)).toHaveAttribute("data-ready", "true");

    const scale = () =>
      activeLivePlayer(page)
        .locator(".react-transform-component")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    expect(await scale()).toBe(1);

    const box = await activeLivePlayer(page).boundingBox();
    if (!box) {
      throw new Error("live player has no bounding box");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);

    await expect.poll(scale).toBeGreaterThan(1);
  });

  test("a line marks the live edge above the newest recording", async ({
    frigateApp,
  }) => {
    const page = frigateApp.page;
    await openAtLiveEdge(frigateApp);
    const marker = page.getByTestId("live-edge-marker");
    await expect(marker).toBeAttached();

    const { y, trackTop } = await measure(page);
    const markerBox = await marker.boundingBox();

    if (!markerBox) {
      throw new Error("live edge marker has no bounding box");
    }

    // now sits on the track, above the playhead two minutes back
    expect(markerBox.y).toBeGreaterThanOrEqual(trackTop - 1);
    expect(markerBox.y).toBeLessThan(y);
  });
});
