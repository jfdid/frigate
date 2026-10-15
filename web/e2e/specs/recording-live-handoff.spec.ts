/**
 * Recording view live handoff -- MEDIUM tier.
 *
 * At the live edge, dragging the handlebar all the way to the top of the
 * timeline and releasing it there opens the camera's live view. A release
 * anywhere lower keeps scrubbing recordings as before.
 */

import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";

// midday, so the recording view's day never crosses midnight
const NOW = new Date(2026, 8, 2, 12, 30, 0);
const playbackTime = Math.floor(NOW.getTime() / 1000) - 120;

async function openAtLiveEdge(frigateApp: FrigateApp) {
  const page = frigateApp.page;

  await page.clock.install({ time: NOW });
  await frigateApp.installDefaults();

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

  const handle = page.locator('[role="scrollbar"] .rounded-full').first();
  await expect(handle).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("video").first()).toBeAttached({
    timeout: 15_000,
  });

  return handle;
}

/** Presses the handlebar and waits until the drag is live. */
async function grabHandle(frigateApp: FrigateApp) {
  const page = frigateApp.page;
  const handle = await openAtLiveEdge(frigateApp);
  const box = await handle.boundingBox();
  // the timeline's scroll container; [role="scrollbar"] is the handlebar's
  // own wrapper and moves with it
  const trackTop = await handle.evaluate(
    (el) => el.closest(".overflow-y-auto")?.getBoundingClientRect().top,
  );

  if (!box || trackTop === undefined) {
    throw new Error("handlebar or timeline has no bounding box");
  }

  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  // the move listener is attached on the render after the press
  await expect(
    page.locator('[role="scrollbar"] .cursor-grabbing').first(),
  ).toBeAttached();

  return { page, x, y: box.y + box.height / 2, trackTop };
}

const hotZone = (page: FrigateApp["page"]) => page.getByTestId("live-hot-zone");

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Recording live handoff: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("releasing the handle at the top of the timeline goes live", async ({
      frigateApp,
    }) => {
      const { page, x, trackTop } = await grabHandle(frigateApp);

      // past the top of the track, where the handle stops
      await page.mouse.move(x, trackTop - 20, { steps: 8 });
      await expect(hotZone(page)).toBeVisible();

      await page.mouse.up();
      await expect(page).toHaveURL(/\/#front_door$/);
    });

    test("releasing the handle lower keeps the recording view", async ({
      frigateApp,
    }) => {
      const { page, x, y } = await grabHandle(frigateApp);

      await page.mouse.move(x, y + 80, { steps: 8 });
      await expect(hotZone(page)).toBeHidden();

      await page.mouse.up();
      await expect(page).toHaveURL(/\/review/);
      await expect(
        page.locator('[role="scrollbar"] .rounded-full').first(),
      ).toBeVisible();
    });

    test("leaving the hot zone before the release cancels the handoff", async ({
      frigateApp,
    }) => {
      const { page, x, y, trackTop } = await grabHandle(frigateApp);

      await page.mouse.move(x, trackTop - 20, { steps: 8 });
      await expect(hotZone(page)).toBeVisible();
      await page.mouse.move(x, y + 80, { steps: 8 });
      await expect(hotZone(page)).toBeHidden();

      await page.mouse.up();
      await expect(page).toHaveURL(/\/review/);
    });
  });
}

test.describe("Recording live handoff: touch @medium", () => {
  test("a touch drag released at the top of the timeline goes live", async ({
    frigateApp,
  }) => {
    test.skip(frigateApp.isMobile);

    const page = frigateApp.page;
    const handle = await openAtLiveEdge(frigateApp);
    const box = await handle.boundingBox();
    const trackTop = await handle.evaluate(
      (el) => el.closest(".overflow-y-auto")?.getBoundingClientRect().top,
    );

    if (!box || trackTop === undefined) {
      throw new Error("handlebar or timeline has no bounding box");
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
    await expect(page).toHaveURL(/\/#front_door$/);
  });
});
