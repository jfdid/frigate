/**
 * Recording live edge playback -- MEDIUM tier.
 *
 * The recording view grows its window toward "now" every 15s while it is
 * open at the live edge, which rebuilds the player's source. These cases
 * play real (tiny) H.264 media through hls.js so the rebuild can be
 * observed: playback in progress continues from the playhead, a paused
 * player stays paused without a stuck loading spinner, and playback that
 * runs into the newest footage carries on with the live stream.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import {
  LIVE_STREAM_CONFIG,
  mockLiveStream,
} from "../helpers/live-stream-mocker";

const SEGMENT_S = 2;

// midday, so the recording view's day never starts inside the test window
const NOW = new Date(2026, 8, 2, 12, 30, 0);
const SEGMENT = readFileSync(
  fileURLToPath(
    new URL("../fixtures/media/recording-2s.mpegts", import.meta.url),
  ),
);

/** Whole segments of footage between after and before. */
function footage(after: number, before: number) {
  const count = Math.max(0, Math.floor((before - after) / SEGMENT_S));
  return { count, end: after + count * SEGMENT_S };
}

async function mockRecordings(frigateApp: FrigateApp) {
  const page = frigateApp.page;

  await page.route("**/api/*/recordings**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/recordings/unavailable**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/review/activity/motion**", (route) =>
    route.fulfill({ json: [] }),
  );

  // footage runs right up to whatever window is asked for, so the window
  // growing at the live edge is what makes new footage appear
  await page.route("**/api/*/recordings/coverage**", (route) => {
    const url = new URL(route.request().url());
    const after = Number(url.searchParams.get("after"));
    const before = Number(url.searchParams.get("before"));
    const { count, end } = footage(after, before);
    const span = {
      start_time: after,
      end_time: end,
      duration: count * SEGMENT_S * 1000,
    };

    return route.fulfill({
      json: {
        spans: [{ start_time: after, end_time: end, streams: ["main"] }],
        timelines: { auto: [span], main: [span], sub: [span] },
        codecs_compatible: true,
        streams: {
          main: {
            video_codec: "h264",
            audio_rate: null,
            audio_codec: null,
            has_audio: false,
            bitrate: 200_000,
          },
        },
      },
    });
  });

  await page.route(
    /\/vod\/[^/]+(?:\/(?:main|sub))?\/start\/[\d.]+\/end\/[\d.]+\/master\.m3u8/,
    (route) =>
      route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: [
          "#EXTM3U",
          '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="avc1.4d401e"',
          "index.m3u8",
          "",
        ].join("\n"),
      }),
  );

  await page.route(
    /\/vod\/[^/]+(?:\/(?:main|sub))?\/start\/([\d.]+)\/end\/([\d.]+)\/index\.m3u8/,
    (route) => {
      const match = route
        .request()
        .url()
        .match(/\/start\/([\d.]+)\/end\/([\d.]+)\//);
      const { count } = footage(Number(match?.[1]), Number(match?.[2]));
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${SEGMENT_S}`,
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
      ];
      for (let i = 0; i < count; i++) {
        // the same segment repeats, so each one restarts its timestamps
        if (i > 0) {
          lines.push("#EXT-X-DISCONTINUITY");
        }
        lines.push(`#EXTINF:${SEGMENT_S.toFixed(3)},`, `seg-${i}.ts`);
      }
      lines.push("#EXT-X-ENDLIST", "");

      return route.fulfill({
        contentType: "application/vnd.apple.mpegurl",
        body: lines.join("\n"),
      });
    },
  );

  await page.route(/\/vod\/.+\/seg-\d+\.ts/, (route) =>
    route.fulfill({ contentType: "video/mp2t", body: SEGMENT }),
  );

  await page.route(/\/api\/preview\/.+\/start\//, (route) =>
    route.fulfill({ json: [] }),
  );
}

async function openAtLiveEdge(frigateApp: FrigateApp, secondsBack: number) {
  const page = frigateApp.page;
  await page.clock.install({ time: NOW });
  await frigateApp.installDefaults({ config: LIVE_STREAM_CONFIG });
  await mockRecordings(frigateApp);
  // playback near the live edge connects the live stream ahead of time;
  // its 3s of media goes out on release(), as a real stream never runs dry
  const stream = await mockLiveStream(page);

  const playbackTime = Math.floor(NOW.getTime() / 1000) - secondsBack;
  await frigateApp.goto(`/review?timestamp=front_door_${playbackTime}`);

  await expect(
    page.locator('[role="scrollbar"] .rounded-full').first(),
  ).toBeVisible({ timeout: 15_000 });

  return stream;
}

const videoState = (frigateApp: FrigateApp) =>
  frigateApp.page.evaluate(() => {
    const video = document.querySelector("video");
    return video
      ? {
          paused: video.paused,
          ended: video.ended,
          currentTime: video.currentTime,
          duration: video.duration,
          readyState: video.readyState,
          src: video.currentSrc,
        }
      : undefined;
  });

const spinner = (frigateApp: FrigateApp) =>
  frigateApp.page.locator('[aria-label="Loading…"]');

const activeLivePlayer = (frigateApp: FrigateApp) =>
  frigateApp.page.locator(
    '[data-testid="recording-live-player"][data-active="true"]',
  );

/** Jumps to just before the end of the loaded footage and lets it end. */
async function playOutFootage(frigateApp: FrigateApp) {
  await frigateApp.page.evaluate(() => {
    const video = document.querySelector("video");
    if (video) {
      video.currentTime = video.duration - 0.3;
    }
  });
  await expect
    .poll(async () => (await videoState(frigateApp))?.ended, {
      timeout: 10_000,
    })
    .toBe(true);
}

/** Runs the clock past two live edge ticks and waits for the rebuild. */
async function tickAndRebuild(frigateApp: FrigateApp) {
  const before = await videoState(frigateApp);
  // the edge starts at the time the view opened and each tick sets it to
  // "now" minus the 15s ingest lag, so the first tick adds almost nothing
  await frigateApp.page.clock.runFor("00:31");
  await expect
    .poll(async () => (await videoState(frigateApp))?.duration ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(before?.duration ?? 0);
}

async function waitForPlayback(frigateApp: FrigateApp) {
  await expect
    .poll(
      async () => {
        const state = await videoState(frigateApp);
        return !!state && !state.paused && state.readyState >= 3;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

test.describe("Recording live edge playback: desktop @medium", () => {
  test("playback that runs into the newest footage carries on live", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    const stream = await openAtLiveEdge(frigateApp, 40);
    await waitForPlayback(frigateApp);
    await playOutFootage(frigateApp);

    await expect(activeLivePlayer(frigateApp)).toBeVisible();
    stream.release();
    await expect(activeLivePlayer(frigateApp)).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(frigateApp.page).toHaveURL(/\/review/);
  });

  test("a paused player stays paused across a live edge tick", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    await openAtLiveEdge(frigateApp, 60);
    await waitForPlayback(frigateApp);

    await frigateApp.page.evaluate(() =>
      document.querySelector("video")?.pause(),
    );
    const pausedAt = (await videoState(frigateApp))?.currentTime ?? 0;

    await tickAndRebuild(frigateApp);

    // past the rebuild's 1s loading timer, which used to leave a spinner
    // over the paused frame for good
    await frigateApp.page.clock.runFor(2000);

    const state = await videoState(frigateApp);
    expect(state?.paused).toBe(true);
    expect(state?.currentTime ?? 0).toBeCloseTo(pausedAt, 0);
    await expect(spinner(frigateApp)).toBeHidden();
  });

  test("playback continues from the playhead across a live edge tick", async ({
    frigateApp,
  }) => {
    if (frigateApp.isMobile) {
      test.skip();
      return;
    }

    await openAtLiveEdge(frigateApp, 120);
    await waitForPlayback(frigateApp);

    // stand in for a minute of natural playback since the view opened;
    // the view's own seek anchor stays where playback started
    await frigateApp.page.evaluate(() => {
      const video = document.querySelector("video");
      if (video) {
        video.currentTime += 60;
      }
    });
    await waitForPlayback(frigateApp);
    const playedTo = (await videoState(frigateApp))?.currentTime ?? 0;

    await tickAndRebuild(frigateApp);

    // the window kept its start, so media time is comparable across the
    // rebuild; snapping back to the anchor would land a minute earlier
    await expect
      .poll(async () => (await videoState(frigateApp))?.currentTime ?? 0)
      .toBeGreaterThan(playedTo - 2);
  });
});

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Recording Go live button: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("the player controls' Go live button plays live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      await openAtLiveEdge(frigateApp, 120);
      await waitForPlayback(frigateApp);
      await expect(activeLivePlayer(frigateApp)).toHaveCount(0);

      // the player's controls show on hover on desktop and are up from
      // the start on touch devices
      if (!mobile) {
        await page.locator("video").first().hover();
      }

      await page.getByTestId("go-live-button").click();

      await expect(activeLivePlayer(frigateApp)).toBeVisible();
      await expect(page.getByTestId("handlebar-label")).toHaveText("Live");
    });
  });
}

test.describe("Recording live edge playback: mobile @medium @mobile", () => {
  test("playback that runs into the newest footage carries on live", async ({
    frigateApp,
  }) => {
    if (!frigateApp.isMobile) {
      test.skip();
      return;
    }

    await openAtLiveEdge(frigateApp, 40);
    await waitForPlayback(frigateApp);
    await playOutFootage(frigateApp);

    await expect(activeLivePlayer(frigateApp)).toBeVisible();
  });
});
