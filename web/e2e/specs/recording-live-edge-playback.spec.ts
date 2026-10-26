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
import type { Page, Route } from "@playwright/test";
import { test, expect, type FrigateApp } from "../fixtures/frigate-test";
import { PLACEHOLDER_PNG } from "../helpers/api-mocker";
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

async function openAtLiveEdge(
  frigateApp: FrigateApp,
  secondsBack: number,
  // extra routes, registered last so they win over the defaults
  routes?: (page: Page) => Promise<void>,
) {
  const page = frigateApp.page;
  await page.clock.install({ time: NOW });
  await frigateApp.installDefaults({ config: LIVE_STREAM_CONFIG });
  await mockRecordings(frigateApp);
  // playback near the live edge connects the live stream ahead of time;
  // its 3s of media goes out on release(), as a real stream never runs dry
  const stream = await mockLiveStream(page);
  await routes?.(page);

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

    test("Go live in a historical view opens the camera live", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      // a day back: the view doesn't follow the live edge
      await openAtLiveEdge(frigateApp, 24 * 3600);
      await waitForPlayback(frigateApp);

      if (!mobile) {
        await page.locator("video").first().hover();
      }

      await page.getByTestId("go-live-button").click();

      // a fresh Camera view at the live edge, already live
      await expect(activeLivePlayer(frigateApp)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page).toHaveURL(/\/review/);
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

const shuttle = (frigateApp: FrigateApp) =>
  frigateApp.page.getByTestId("shuttle");
const shuttleThumb = (frigateApp: FrigateApp) =>
  shuttle(frigateApp).getByRole("slider");

/** The handle's offset from the top of the timeline's scrolled content. */
const handleOffset = (frigateApp: FrigateApp) =>
  frigateApp.page
    .locator('[role="scrollbar"] .rounded-full')
    .first()
    .evaluate((el) => {
      const track = el.closest(".overflow-y-auto");
      return track
        ? el.getBoundingClientRect().top -
            track.getBoundingClientRect().top +
            track.scrollTop
        : 0;
    });

/** Moves the shuttle by a number of stops, negative to the left. */
async function moveShuttle(frigateApp: FrigateApp, stops: number) {
  await shuttleThumb(frigateApp).focus();

  for (let i = 0; i < Math.abs(stops); i++) {
    await frigateApp.page.keyboard.press(
      stops > 0 ? "ArrowRight" : "ArrowLeft",
    );
  }
}

const playbackRate = (frigateApp: FrigateApp) =>
  frigateApp.page.evaluate(() => document.querySelector("video")?.playbackRate);

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Recording shuttle: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("right of the middle plays faster, the middle pauses", async ({
      frigateApp,
    }) => {
      await openAtLiveEdge(frigateApp, 120);
      await waitForPlayback(frigateApp);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "1");

      await moveShuttle(frigateApp, 2);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "4");
      await expect.poll(() => playbackRate(frigateApp)).toBe(4);
      // the thumb shows the speed on desktop; a finger covers it on touch
      await expect(frigateApp.page.getByTestId("shuttle-thumb")).toHaveText(
        mobile ? "" : "4x ▶",
      );
      expect((await videoState(frigateApp))?.paused).toBe(false);

      await moveShuttle(frigateApp, -3);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "0");
      await expect(frigateApp.page.getByTestId("shuttle-label")).toHaveText(
        "Paused",
      );
      await expect
        .poll(async () => (await videoState(frigateApp))?.paused)
        .toBe(true);
    });

    test("the player's speed menu shows on the shuttle", async ({
      frigateApp,
    }) => {
      await openAtLiveEdge(frigateApp, 120);
      await waitForPlayback(frigateApp);

      await frigateApp.page.evaluate(() => {
        const video = document.querySelector("video");
        if (video) {
          video.playbackRate = 8;
        }
      });

      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "8");
    });

    test("left of the middle runs back in time, then plays forward again", async ({
      frigateApp,
    }) => {
      await openAtLiveEdge(frigateApp, 120);
      await waitForPlayback(frigateApp);
      const startOffset = await handleOffset(frigateApp);

      // 1x, pause, then reverse at 1, 2, 4, 8 and 16x
      await moveShuttle(frigateApp, -6);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-16");
      await expect(frigateApp.page.getByTestId("shuttle-label")).toHaveText(
        "◀ 16x",
      );

      // 5s at 16x is 80s back: the handle moves down the timeline
      await frigateApp.page.clock.runFor(5000);
      await expect
        .poll(() => handleOffset(frigateApp))
        .toBeGreaterThan(startOffset + 10);
      expect((await videoState(frigateApp))?.paused).toBe(true);

      // back through pause to 1x forward
      await moveShuttle(frigateApp, 6);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "1");
      await waitForPlayback(frigateApp);
      await expect.poll(() => playbackRate(frigateApp)).toBe(1);
    });

    test("reverse from live leaves live and rewinds", async ({
      frigateApp,
    }) => {
      const stream = await openAtLiveEdge(frigateApp, 40);
      await waitForPlayback(frigateApp);
      await playOutFootage(frigateApp);
      await expect(activeLivePlayer(frigateApp)).toBeVisible();
      stream.release();
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "live");

      // live already runs in real time: right of the middle stays live
      await moveShuttle(frigateApp, 1);
      await expect(activeLivePlayer(frigateApp)).toBeVisible();

      await moveShuttle(frigateApp, -2);
      await expect(activeLivePlayer(frigateApp)).toHaveCount(0);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-2");
    });
  });
}

// reverse runs on the preview images. These cases serve them the way the
// server does: the current hour as cached frames, an earlier hour as a
// 1 fps mp4 like the one the preview writer makes
const PREVIEW_MP4 = readFileSync(
  fileURLToPath(new URL("../fixtures/media/preview-600s.mp4", import.meta.url)),
);
const PREVIEW_MP4_S = 600;

/**
 * Serves a file with byte range support, as nginx does. Chrome can't seek
 * in media served without it: every seek lands at 0.
 */
function fulfillWithRanges(route: Route, body: Buffer, contentType: string) {
  const range = route
    .request()
    .headers()
    ["range"]?.match(/bytes=(\d+)-(\d*)/);

  if (!range) {
    return route.fulfill({
      contentType,
      body,
      headers: { "Accept-Ranges": "bytes" },
    });
  }

  const start = Number(range[1]);
  const end = range[2] ? Number(range[2]) : body.length - 1;

  return route.fulfill({
    status: 206,
    contentType,
    body: body.subarray(start, end + 1),
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
    },
  });
}

/** Serves a cached frame for every second of the requested range. */
async function mockDenseFrames(
  page: Page,
  { failing = () => false }: { failing?: (time: number) => boolean } = {},
) {
  await page.route(
    /\/api\/preview\/[^/]+\/start\/[\d.]+\/end\/[\d.]+\/frames/,
    (route) => {
      const match = route
        .request()
        .url()
        .match(/\/start\/([\d.]+)\/end\/([\d.]+)\//);
      const after = Math.ceil(Number(match?.[1]));
      const before = Math.floor(Number(match?.[2]));
      const frames = [];
      for (let t = after; t <= before; t++) {
        frames.push(`preview_front_door-${t}.webp`);
      }
      return route.fulfill({ json: frames });
    },
  );
  await page.route(/\/api\/preview\/preview_.+\/thumbnail\.webp/, (route) => {
    const time = Number(
      route
        .request()
        .url()
        .match(/-([\d.]+)\.webp\/thumbnail/)?.[1],
    );
    return failing(time)
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ contentType: "image/png", body: PLACEHOLDER_PNG });
  });
}

/** Lists a preview mp4 for [start, start + PREVIEW_MP4_S] and serves it. */
async function mockPreviewMp4(page: Page, start: number) {
  await page.route(
    /\/api\/preview\/all\/start\/[\d.]+\/end\/[\d.]+$/,
    (route) =>
      route.fulfill({
        json: [
          {
            camera: "front_door",
            src: `/clips/previews/front_door/${start}-${start + PREVIEW_MP4_S}.mp4`,
            type: "video/mp4",
            start,
            end: start + PREVIEW_MP4_S,
          },
        ],
      }),
  );
  await page.route("**/clips/previews/**", (route) =>
    fulfillWithRanges(route, PREVIEW_MP4, "video/mp4"),
  );
}

const previewVideoTime = (page: Page) =>
  page
    .locator('[data-camera="front_door"] video')
    .evaluate((video: HTMLVideoElement) => video.currentTime);

/** Frame times the scrub preview has asked for, in order. */
function recordFrameRequests(page: Page) {
  const times: number[] = [];
  page.on("request", (request) => {
    const match = request
      .url()
      .match(/preview_front_door-([\d.]+)\.webp\/thumbnail/);
    if (match) {
      times.push(Number(match[1]));
    }
  });
  return times;
}

/** Lets reverse run in small clock steps, so image loads keep up. */
async function runReverse(frigateApp: FrigateApp, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await frigateApp.page.clock.runFor(100);
    // image loads and seeks complete in real time, not on the page clock
    await expect
      .poll(() =>
        frigateApp.page.evaluate(
          () =>
            Array.from(document.querySelectorAll("img"))
              .filter((img) => img.src.includes("preview_"))
              .every((img) => img.complete) &&
            Array.from(
              document.querySelectorAll<HTMLVideoElement>(
                "[data-camera] video",
              ),
            ).every((video) => !video.seeking),
        ),
      )
      .toBe(true);
  }
}

for (const mobile of [false, true]) {
  const tags = mobile ? "@medium @mobile" : "@medium";

  test.describe(`Recording shuttle reverse previews: ${mobile ? "mobile" : "desktop"} ${tags}`, () => {
    test.beforeEach(({ frigateApp }) => {
      test.skip(frigateApp.isMobile != mobile);
    });

    test("reverse in the current hour steps back through every cached frame", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const requested = recordFrameRequests(page);
      await openAtLiveEdge(frigateApp, 120, (page) => mockDenseFrames(page));
      await waitForPlayback(frigateApp);
      const start = Math.floor(NOW.getTime() / 1000) - 120;

      // pause, then reverse at 1x and 2x
      await moveShuttle(frigateApp, -3);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-2");
      requested.length = 0;

      // 3s at 2x is 6s of footage: one frame a second, newest first
      await runReverse(frigateApp, 3000);

      const distinct = [...new Set(requested)];
      expect(distinct.length).toBeGreaterThanOrEqual(4);
      expect(Math.min(...distinct)).toBeLessThan(start - 3);
      // never forward while reversing
      for (let i = 1; i < distinct.length; i++) {
        expect(distinct[i]).toBeLessThan(distinct[i - 1]);
      }
    });

    test("a frame that fails to load doesn't stop reverse", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const requested = recordFrameRequests(page);
      const start = Math.floor(NOW.getTime() / 1000) - 120;
      // the first few frames behind the playhead are gone, as when the
      // cache was cleared after the listing was fetched
      await openAtLiveEdge(frigateApp, 120, (page) =>
        mockDenseFrames(page, {
          failing: (time) => time <= start && time > start - 3,
        }),
      );
      await waitForPlayback(frigateApp);

      await moveShuttle(frigateApp, -3);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-2");
      requested.length = 0;

      await runReverse(frigateApp, 4000);

      // reverse carried on past the missing frames
      expect(Math.min(...requested)).toBeLessThan(start - 4);
    });

    test("reverse in an earlier hour plays the hour's preview video backwards", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      // two hours back: that hour has its preview mp4
      const hourStart = new Date(2026, 8, 2, 10, 0, 0).getTime() / 1000;
      const previewStart = hourStart + 1;

      await openAtLiveEdge(
        frigateApp,
        Math.floor(NOW.getTime() / 1000) - (previewStart + 300),
        (page) => mockPreviewMp4(page, previewStart),
      );
      await waitForPlayback(frigateApp);

      const previewVideo = page.locator('[data-camera="front_door"] video');
      await expect(previewVideo).toBeAttached();

      await moveShuttle(frigateApp, -5);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-8");

      // the preview shows, positioned near the playhead
      await expect(previewVideo).toBeVisible();
      await expect
        .poll(() =>
          previewVideo.evaluate((video: HTMLVideoElement) => video.currentTime),
        )
        .toBeGreaterThan(250);
      const before = await previewVideo.evaluate(
        (video: HTMLVideoElement) => video.currentTime,
      );

      // 3s at 8x is 24s of footage
      await runReverse(frigateApp, 3000);

      await expect
        .poll(() =>
          previewVideo.evaluate((video: HTMLVideoElement) => video.currentTime),
        )
        .toBeLessThan(before - 15);
    });

    test("reverse carries on into the previous hour's preview", async ({
      frigateApp,
    }) => {
      const page = frigateApp.page;
      const hourStart = new Date(2026, 8, 2, 12, 0, 0).getTime() / 1000;
      // the previous hour's preview covers its last ten minutes
      const previewStart = hourStart - PREVIEW_MP4_S;

      await openAtLiveEdge(
        frigateApp,
        Math.floor(NOW.getTime() / 1000) - (hourStart + 20),
        async (page) => {
          await mockDenseFrames(page);
          await mockPreviewMp4(page, previewStart);
        },
      );
      await waitForPlayback(frigateApp);

      // 1x, pause, then reverse up to 16x
      await moveShuttle(frigateApp, -6);
      await expect(shuttle(frigateApp)).toHaveAttribute("data-rate", "-16");

      // 3s at 16x is 48s back: past the start of the hour
      await runReverse(frigateApp, 3000);

      // the previous hour's preview took over, near its end, and keeps
      // running back
      await expect(
        page.locator('[data-camera="front_door"] video'),
      ).toBeVisible();
      await expect
        .poll(() => previewVideoTime(page))
        .toBeGreaterThan(PREVIEW_MP4_S - 60);
      const crossed = await previewVideoTime(page);
      expect(crossed).toBeLessThan(PREVIEW_MP4_S);

      await runReverse(frigateApp, 2000);
      await expect
        .poll(() => previewVideoTime(page))
        .toBeLessThan(crossed - 15);
    });
  });
}
