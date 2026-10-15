/**
 * Camera view -- MEDIUM tier.
 *
 * Fork behavior: opening one camera (a dashboard tile, a /#camera link)
 * goes to the Camera view, the recording view already showing the live
 * stream, instead of the classic single-camera live page. The classic page
 * stays reachable through the Controls button (/?controls#camera).
 */

import type { Page } from "@playwright/test";
import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";
import {
  LIVE_STREAM_CONFIG,
  mockLiveStream,
} from "../helpers/live-stream-mocker";
import { LivePage } from "../pages/live.page";

// midday, so the recording view's day never crosses midnight
const NOW = new Date(2026, 8, 2, 12, 30, 0);
const nowS = Math.floor(NOW.getTime() / 1000);

async function setUp(frigateApp: FrigateApp) {
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
          { start_time: nowS - 3600, end_time: nowS - 20, streams: ["main"] },
        ],
        timelines: Object.fromEntries(
          ["auto", "main", "sub"].map((key) => [
            key,
            [
              {
                start_time: nowS - 3600,
                end_time: nowS - 20,
                duration: 3580 * 1000,
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

  return stream;
}

const activeLivePlayer = (page: Page) =>
  page.locator('[data-testid="recording-live-player"][data-active="true"]');
const handle = (page: Page) =>
  page.locator('[role="scrollbar"] .rounded-full').first();

async function expectLiveCameraView(page: Page) {
  await expect(page).toHaveURL(/\/review/);
  await expect(activeLivePlayer(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("handlebar-label")).toHaveText("Live", {
    timeout: 15_000,
  });
}

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Camera view: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("opening a camera from the dashboard shows it live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const stream = await setUp(frigateApp);
      await frigateApp.goto("/");
      const live = new LivePage(page, !mobile);

      await live.cameraCard("front_door").first().click({ timeout: 10_000 });
      await expectLiveCameraView(page);

      stream.release();
      await expect(activeLivePlayer(page)).toHaveAttribute(
        "data-ready",
        "true",
      );
    });

    test("a /#camera link opens the Camera view live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await setUp(frigateApp);

      await frigateApp.goto("/#front_door");
      await expectLiveCameraView(page);
    });

    test("back from the Camera view returns to the dashboard", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await setUp(frigateApp);
      await frigateApp.goto("/");
      const live = new LivePage(page, !mobile);

      await live.cameraCard("front_door").first().click({ timeout: 10_000 });
      await expectLiveCameraView(page);
      await page.getByRole("button", { name: "Back" }).first().click();

      await expect(live.cameraCard("front_door").first()).toBeVisible({
        timeout: 10_000,
      });
    });

    test("Controls opens the classic live page for the camera", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await setUp(frigateApp);
      await frigateApp.goto("/#front_door");
      await expectLiveCameraView(page);

      await page
        .getByRole("button", { name: /camera's live controls/ })
        .click();

      await expect(page).toHaveURL(/\?controls#front_door/);
      await expect(
        page.getByRole("button", { name: "Show historical footage" }),
      ).toBeVisible({ timeout: 10_000 });
    });

    test("the Live button goes back to live in place", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await setUp(frigateApp);
      await frigateApp.goto("/#front_door");
      await expectLiveCameraView(page);

      // tap the timeline lower down to leave live for recordings
      const box = await handle(page).boundingBox();
      if (!box) {
        throw new Error("handlebar has no bounding box");
      }
      await page.mouse.click(box.x + box.width / 2, box.y + 150);
      await expect(activeLivePlayer(page)).toHaveCount(0);

      await page
        .getByRole("button", { name: "Go to the main camera live view" })
        .click();
      await expect(activeLivePlayer(page)).toBeVisible();
      await expect(page).toHaveURL(/\/review/);
    });
  });
}
