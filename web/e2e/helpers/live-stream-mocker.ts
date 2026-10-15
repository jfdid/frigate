/**
 * A go2rtc MSE live stream that really plays.
 *
 * Answers the MSE socket's codec negotiation and streams a 3s fragmented
 * MP4, so a live player reaches its playing state in Chromium. Media goes
 * out once `release()` is called, so a test can see the stream still
 * loading first. The clip is short, so release it only once the player
 * should be showing, the way a real stream is always flowing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// 3s 320x180 H.264 baseline, fragmented for MSE
const LIVE_MEDIA = readFileSync(
  fileURLToPath(new URL("../fixtures/media/live-3s.mp4", import.meta.url)),
);
const LIVE_CODECS = 'video/mp4; codecs="avc1.42C01E"';

/** Config that restreams front_door through go2rtc, so the player uses MSE. */
export const LIVE_STREAM_CONFIG = {
  go2rtc: {
    streams: { front_door: ["rtsp://127.0.0.1:8554/front_door"] },
    webrtc: { candidates: [], ice_servers: [] },
  },
};

export async function mockLiveStream(page: Page) {
  const sockets: { send: () => void }[] = [];
  let released = false;

  await page.routeWebSocket("**/live/mse/api/ws**", (ws) => {
    let negotiated = false;
    const sendMedia = () => {
      if (negotiated) {
        ws.send(LIVE_MEDIA);
      }
    };
    sockets.push({ send: sendMedia });

    ws.onMessage((message) => {
      const msg = JSON.parse(message.toString());
      if (msg.type !== "mse") {
        return;
      }

      ws.send(JSON.stringify({ type: "mse", value: LIVE_CODECS }));
      negotiated = true;

      if (released) {
        sendMedia();
      }
    });
  });

  await page.route("**/api/go2rtc/streams/**", (route) =>
    route.fulfill({
      json: {
        producers: [{ medias: ["video, recvonly, H264"] }],
        consumers: [],
      },
    }),
  );

  return {
    release() {
      released = true;
      sockets.forEach((socket) => socket.send());
    },
  };
}
