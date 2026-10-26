# jfdid/frigate fork notes

This file is the single reference for everything this fork changes on top of
upstream Frigate, why, and how to carry it forward to new upstream versions.
It is written for both the maintainer and for AI agents that start with no
memory of earlier sessions. **Agents: read this whole file before changing
anything in this fork, and also `FORK.local.md` when it exists: the
maintainer's own setup and rules, kept out of the repo.**

This is an unofficial fork. It is not supported by the Frigate team; don't
report problems with it upstream.

Last updated: 2026-10-25, on branch `feature/live-overlay` (from `mods`).

## 1. Orientation

| What | Where |
|---|---|
| Fork | `github.com/jfdid/frigate` (remote `origin`) |
| Upstream | `github.com/blakeblackshear/frigate` (remote `upstream`), branch `dev` |
| Branch with all fork changes | `mods` (this branch, the fork's default on GitHub). Build and deploy from it. Named `overnight/scrub-fix` until 2026-10-15 |
| Fork `dev` and `main` | Plain snapshots of upstream `dev` (`b79e04397`, older than this branch's base). No fork changes |
| Upstream base of this branch | `62ca5b25e`, upstream `dev` after it merged v0.18.2 (2026-10-15), version 0.19.0-dev. Includes every fix in v0.18.1 and v0.18.2 |

Commit IDs change on every rebase, so this file refers to commits by subject.
List them with `git log --oneline upstream/dev..mods`.

### Building

Build an image from this branch the same way as upstream, for example
`make local` (main image) or `make local-trt` (NVIDIA), then run it like any
Frigate image. The maintainer's machines, deploy steps and working rules
are in `FORK.local.md`, which is not committed.

### Rules for agents working on this fork

- Never open upstream PRs, issues, or comments without the maintainer's
  explicit go-ahead.
- Keep personal details (hostnames, hardware, container names, camera names,
  IPs, domains, emails, credentials) out of everything committed, including
  this file and commit and tag messages. They belong in `FORK.local.md`.
- Commit only with the identity configured in the repo; see
  `FORK.local.md`.
- Long unattended work goes on a new branch, not on `mods`.

## 2. Summary of changes

| # | Area | Commit subject | Why |
|---|---|---|---|
| 1 | Live edge | recording view: stop the timeline top edge freezing while open | Piece 1: the top of the timeline froze at the moment the view opened |
| 2 | Live edge | recording view: let the live edge grow so new footage becomes visible | Piece 2: footage recorded after opening the view was invisible until a reload |
| 3 | Live edge | recording view: keep the handlebar when the live edge ticks | Each 15s tick swapped the timeline to a skeleton and dropped a held handle |
| 4 | Live edge | recording view: keep following the live edge and the playhead | Growth stopped after one minute; each tick snapped playback back to the last seek |
| 5 | Live edge | recording view: resume and stay stable across live edge ticks | Video stuck with a spinner at the top; another jump back cause; frames player rebuilt every tick |
| 6 | Scrubbing | preview frames: show the newest frame when scrubbing past it | Scrubbing past the newest cached frame left a stale image |
| 7 | Scrubbing | timeline drag: flush the held drag time when the handle stops | Upstream bug (also in 0.18.0): the preview lagged a handle that stopped moving |
| 8 | Backend | output: keep writing preview frames when frame slots run out of descriptors | Scrub frames for all cameras stopped about 10s after startup |
| 9 | Live edge | recording view: go live when the handle is released at the top | Piece 3: the drag-to-top trigger (first version navigated to the live page) |
| 10 | Live edge | recording view: play live inside the view at the live edge | Piece 3: live stream in place of the recording player, auto-live, warm-up, live edge marker |
| 12 | Camera view | recording view: zoom and pan the live stream | Pinch/scroll zoom and drag to pan on the live stream, like the recording player |
| 11 | Camera view | live: open cameras in the Camera view | One screen per camera: dashboard tiles, Birdseye and `/#camera` links open the recording view already live, the classic live page moves behind a Controls button. Also: the handle reads "Live" while live (a pinned time lagged the picture), and only user actions leave live |
| 13 | Backend | nginx: don't warn about the go2rtc stream flag on every request | Upstream bug (from the v0.18.2 security fix): every authenticated request logged `using uninitialized "go2rtc_stream_proxy" variable` |
| 14 | Camera view | recording view: fullscreen controls while live and a Go live button | Live had no controls, so no way to go fullscreen; going live needed a drag to the top of a possibly long timeline |
| 15 | Camera view | recording view: Blue Iris style shuttle for speed and reverse | One slider under the video: pause in the middle, forward or reverse at 1 to 16x. Kept on its own branch (`feature/shuttle`) so it can be dropped |
| 16 | Previews | previews: a frame every second, and skip frames that fail to load | Still scenes and stationary objects got one preview frame every 30s, so scrubbing (and reverse) through them showed almost nothing; one missing frame froze the scrub preview for good |

Commits 1 to 7, 9 to 12, 14 and 15 are frontend only (`web/`). Commit 8 is backend only
(`frigate/`), commit 13 only touches the nginx config (`docker/`), and commit
16 touches the preview writer and the frames player. Documentation commits (`docs: ...`) only touch this file and
`AGENTS.md`.

## 3. Live edge and Camera view (commits 1 to 5, 9 to 11)

### Goal

A Blue Iris style live edge in the Review/Recording view, in three pieces:

1. The top of the timeline keeps moving with real time (done).
2. The view's recordings window keeps growing, so new footage can be scrubbed
   and played without reopening the view (done).
3. A hot zone: dragging the handle to the top of the timeline hands off to the
   live stream (done, see "Live handoff" below).

### The core problem

`RecordingView` receives a `timeRange` prop that is fixed for its whole
lifetime. `web/src/pages/Events.tsx` also uses `selectedTimeRange.before` as
the React `key` of `<RecordingView>`, so changing the range there remounts the
view and loses zoom, scroll and playback. The fork therefore never changes
`timeRange`; it grows a local copy instead.

### How it works

All in `web/src/views/recording/RecordingView.tsx` unless noted.

- `RECORDING_INGEST_LAG_S = 15`: the live edge trails real time by 15s,
  because segments roll about every 10s and the recording maintainer polls
  every 5s. This keeps the view from advertising footage that can't exist yet.
- `followsLiveEdge` is decided **once at mount** with `useState`: true when the
  view opened within 60s of now. Re-deciding later compared a stale
  `timeRange.before` with a later clock and silently stopped following after
  about a minute.
- `liveEdgeBefore` state grows every 15s by a `setInterval` while
  `followsLiveEdge` is true. The interval is **paused while `scrubbing`**,
  because a tick rebuilds the timeline under a held handle. `scrubbing` state
  was moved above this code for that reason.
- `effectiveTimeRange = { after: timeRange.after, before: liveEdgeBefore }`
  replaces `timeRange` everywhere data depends on it: `getChunkedTimeDay`,
  the `Timeline` component's `timeRange` prop, and through it the motion,
  coverage and unavailable queries and the video and preview players. The raw
  `timeRange` is still used where mount time is intended (initial playback
  start, quality coverage).
- In `Timeline` (same file), the three SWR queries
  (`review/activity/motion`, `recordings/unavailable`,
  `{camera}/recordings/coverage`) use `keepPreviousData: true`, and the
  skeleton only shows when `isLoading && motionData == undefined`. Without
  this, every tick changed the SWR keys, showed the skeleton, unmounted
  `MotionReviewTimeline` and dropped the handle. `MotionReviewTimeline` gets
  `timelineStart={timeRange.before}`, which is now the growing value.

### Video player across ticks

`web/src/components/player/dynamic/DynamicVideoPlayer.tsx`. Each tick changes
`recordingParams.before`, which rebuilds the HLS source.

- `builtSourceRef` remembers `{camera, after, before}` of the current source.
  `extendsSource` is true when the new source has the same camera and `after`
  and a larger `before`: the live edge grew.
- For an extension (as for a quality switch), the rebuild anchors to the live
  playhead (`controller.getProgress(player.currentTime)`), not to the
  `startTimestamp` prop, which is the last explicit seek. Without this,
  playback jumped back every 15s.
- `getProgress` results below `recordingParams.after` are ignored, falling
  back to `lastPlayedTimestampRef`. A controller recreated while coverage
  reloads has no model yet and maps every position to 0.
- `resumePlaybackRef = !extendsSource || !player || !player.paused ||
  player.ended`. A paused player stays paused across a tick. A player that ran
  out of footage reads as paused and ended, and must resume, because it was
  waiting for exactly this extension.
- `onPlayerLoaded`: when a rebuild stays paused, it clears the loading timer
  and `isLoading`/`isBuffering`. Normally only `onPlaying` clears them, so a
  paused rebuild kept its spinner forever.
- `seekToTimestamp(anchor, !isScrubbing && resumePlaybackRef.current)` and
  `autoplay = !isScrubbing && resumePlaybackRef.current` apply the same rule.

### Preview frames player across ticks

`web/src/components/player/PreviewPlayer.tsx`. `PreviewPlayer` uses
`PreviewVideoPlayer` (hourly preview MP4s) when a preview video exists for the
range, and `PreviewFramesPlayer` for the current or previous hour, which is
the live edge case. That player fetches
`preview/{camera}/start/{after}/end/{before}/frames`, a list of cached
`preview_{camera}-{time}.webp` stills.

- The frames query uses `keepPreviousData: true`, filtered to
  `preview_${camera}-` because kept data can belong to the previous camera.
- The `PreviewFramesController` memo depends on
  `[imgRef, camera, frameTimes === undefined, imgRef.current]`, not on
  `frameTimes`, and an effect assigns `controller.frameTimes` when the list
  refreshes. Rebuilding the controller every tick also rebuilt the main video
  controller, which then reported position 0 (see above).

### What the timeline shows near now

There is an intentional gap between the newest ingested recording and
`liveEdgeBefore`. The player refuses to seek past known recordings
(`DynamicVideoController.seekToTimestamp` shows "No recordings found for this
time") and the timeline draws spans without recordings muted.

### Live mode (piece 3, commits 9 to 11)

The recording view can show the camera's live stream in place of the
recording player, without leaving the view. Commit 9 added the trigger
(first navigating to the live page); commit 10 replaced the navigation with
the in-view live mode below.

**Going live**

- Drag the handle all the way to the top of the timeline. A red "Go live"
  badge appears; release there. Moving back down before the release cancels.
- Or let playback run into the newest footage: when the recording player
  ends (`onClipEnded`) in the last chunk within `AUTO_LIVE_REACH_S = 60` of
  the live edge, `onRecordingClipEnded` goes live instead of the usual
  next-chunk step.
- Or press **Go live** in the recording player's controls (commit 14):
  `VideoControls` takes an optional `onGoLive` (passed through
  `DynamicVideoPlayer` and `HlsVideoPlayer`) and shows a red "Go live"
  button next to fullscreen (`data-testid="go-live-button"`). The view's
  `goLiveButton` goes live in place when `liveAllowed`, else opens
  `/#camera`, and is left out while exporting or picking a debug replay
  range. The controls are hidden while the recording player is loading,
  like all its controls.
- Live starts unmuted (`LivePlayer` `playAudio`). The release is a user
  gesture, and the auto path relies on the page's earlier interaction; if
  the browser still refuses sound, the MSE player falls back to muted.

**While live**

- `RecordingLivePlayer` covers the player area (`absolute inset-0 z-30`)
  with a pulsing "LIVE" badge and, until the stream plays, "Loading live
  stream…".
- Pinch or scroll zooms the live stream and dragging pans it, through the
  same `react-zoom-pan-pinch` `TransformWrapper` settings as the recording
  player (`minScale` 1, wheel `smoothStep` 0.005), disabled while warming
  up. The wrapper stays mounted while the stream is warm, so a zoom
  survives leaving and returning to live within the linger time.
- The recording player stays mounted underneath, paused, with
  `isScrubbing` true (`scrubbing || isLive || ...`). That keeps live edge
  rebuilds from starting it and keeps its preview frames ready, so leaving
  live shows recordings at once.
- The handle is pinned to the top of the track: `pinLiveTime` sets
  `currentTime` to `liveEdgeBefore` and records it in `livePinnedTimeRef`;
  it re-pins on every live edge tick. `onTimestampUpdate` ignores the
  covered recording player while `isLiveRef` is set.
- Controls (commit 14): hovering (desktop) or tapping (touch, hidden again
  after 4s) shows a small pill at the bottom with mute and volume
  (`live-mute`; not for jsmpeg, which has no audio) and fullscreen, where
  the browser supports it (`live-controls`, `live-fullscreen`). Mute and
  volume feed `LivePlayer`'s `playAudio` and `volume`. Fullscreen uses the view's
  `useFullscreen(mainLayoutRef)`, the same element as the recording
  player's button, so the timeline stays usable. A drag that pans a zoomed
  stream doesn't toggle the pill (`onPanning` sets `pannedRef`).
- Switching cameras in the strip stays live on the new camera.
- `LiveEdgeMarker` (in `RecordingView.tsx`) draws a red line across the
  timeline at the real current time, updated every second and on scroll,
  using MotionReviewTimeline's layout (the track starts at
  `alignStartDateToTimeline(timelineStart) + 2 * segmentDuration`, 8px per
  segment). Between ticks "now" can pass the top of the track; the line
  then sits at the top. Shown whenever the view follows the live edge.
  The gap between it and the newest recording is the 15 to 25s ingest lag.

**Leaving live**

Only user actions leave live; the timeline adjusting its own handle while
live (it snaps the handle to the nearest segment when it settles, and its
drag hook writes a time in the render that starts a drag) is ignored, so
the handle stays pinned.

- Drag the handle down: once the pointer moves `LEAVE_LIVE_DRAG_PX = 8`
  below where the drag started (and out of the hot zone), `onLeaveLive`
  runs and the drag scrubs recordings as usual. A live handle pressed and
  released without that move stays live (the release calls `onGoLive`
  again, which re-pins).
- Tap the timeline: `Timeline` passes its own `setHandlebarTime` wrapper to
  `MotionReviewTimeline`. While live, a time set within 1s of a press on
  the timeline (`onPointerDownCapture` on the `Timeline` root records it)
  leaves live and moves the handle; any other set is ignored. A press on
  the handle itself (`[role="scrollbar"]`) counts as a drag from the moment
  of the press (`handlebarHeldRef`), because the drag hook sets a time
  before the drag is reported.
- Seeks: `manuallySetCurrentTime` (clip buttons, keys, list entries, the
  player's own seek controls) calls `leaveLive()` first.
- Leaving reruns the release-seek effect (it has `isLive` in its deps and
  skips while live), which seeks and plays from the handle.
- Export or debug replay (`liveAllowed` false) also leaves live.
- While live the handle reads "Live" (`views/events` `liveEdge.handlebar`)
  instead of a time: `ReviewTimeline` takes a `handlebarLabel` prop (passed
  through `MotionReviewTimeline`) that hides the time text the drag hook
  writes and shows the label (`data-testid="handlebar-label"`).

**Warm-up: connecting before the switch**

A live stream takes a moment to connect, so `RecordingLivePlayer` is
mounted early, muted, transparent and unclickable (`opacity-0`, not
`visibility: hidden`, which browsers may treat as off screen and stop
decoding). It warms while live, while the handle is held in the hot zone
(`onLiveHotZoneChange`), or while the playhead is within
`LIVE_WARM_REACH_S = 45` of the live edge, and stays connected
`LIVE_WARM_LINGER_MS = 30s` after that. The rest of the time no live
stream is open.

**Stream choice** (`web/src/components/player/RecordingLivePlayer.tsx`,
fork-owned): reads the live page's saved per-camera preferences
(`{camera}-stream`, `{camera}-preferred-live-mode`,
`{camera}-force-low-bandwidth`) without the live page's adaptive Auto
selection. The pinned stream if it still exists, else the camera's first
stream. MSE by default, WebRTC if preferred, jsmpeg for low bandwidth,
non-restreamed cameras, or after any `onError`. Ready means
`onLiveAspectChange` reported an aspect, which `LivePlayer` only does once
the stream plays; `showStillWithoutActivity={false}` keeps it streaming
instead of showing a still image.

**Hot zone details**

- `Timeline` wraps `setScrubbing` in a stable `onHandlebarDraggingChange`.
  It must stay stable: `ReviewTimeline` re-reports the drag state whenever
  that callback's identity changes.
- While the handle is held, window `mousemove` and `touchmove` listeners set
  `inLiveHotZone` when the timeline's scroll container is at its top
  (`scrollTop <= 1`) and the pointer is above its top edge plus
  `LIVE_HOT_ZONE_PX = 12`.
- Why the pointer and not the handle time: `useDraggableElement` stops the
  handle 1.5 segments (12px) below the top of the track and, once a drag hits
  that limit, stops reporting new times. The last reported time can be well
  below the top after a fast fling, so a time threshold is unreliable.
- Dragging into the top edge auto-scrolls the timeline up (upstream
  behavior), so holding the handle at the top of a scrolled-back timeline
  climbs to the live edge first, then the badge appears.
- Test ids: `live-hot-zone`, `recording-live-player` (with `data-active` and
  `data-ready`), `live-edge-marker`. Strings: `views/events` keys
  `liveEdge.goLive`, `liveEdge.live`, `liveEdge.loadingStream` in
  `web/public/locales/en/views/events.json`.

### Camera view (commit 11)

"Camera view" is this fork's name for the recording view
(`RecordingView`) now that it shows live and history for one camera.
Upstream reaches it from Review items and the live page's History button
and doesn't name it.

- `web/src/pages/Live.tsx`: every way of opening one camera on the Live page
  (a dashboard tile, a Birdseye camera, a `/#camera` link from a bookmark,
  Home Assistant or a notification) sets the hash to the camera. An effect
  then replaces the history entry with `/review` and a `recording`
  starting point (`startTime` now minus 30s, `live: true`), so Back from the
  Camera view returns to the dashboard.
- `RecordingStartingPoint.live` (`web/src/types/record.ts`, fork field)
  makes `RecordingView` start with `isLive` true when `liveAllowed`.
- The classic single-camera live page (`LiveCameraView`) is still there for
  what the Camera view lacks (PTZ and presets, autotracking, two-way talk,
  digital zoom, the camera toggles, stream selection, picture in picture,
  live transcription): `/?controls#camera` renders it instead of
  redirecting. The Camera view's header has a **Controls** button
  (`LuSlidersHorizontal`, `views/events` `cameraView.controls`) that opens
  it. Its Back returns to the Camera view.
- The header's upstream **Live** button is removed (commit 14). The player
  controls' **Go live** button does its job: live in place when the view
  follows the live edge; in a historical view it opens `/#camera`, i.e. a
  fresh Camera view at the live edge.
- Upstream e2e specs that open the classic page by URL now use
  `/?controls#camera` (`live.spec.ts`, `live-auto-stream.spec.ts`,
  `live-webrtc-availability.spec.ts`), and the tile click tests in
  `live.spec.ts` and `masonry-live-grid.spec.ts` expect `/review`. Redo these
  mechanical edits if a rebase conflicts in them.
- Planned step 2, waiting on the maintainer's list: bring the classic page's
  features the maintainer uses into the Camera view, after which the classic
  page is only a fallback.

### Shuttle (commit 15, branch `feature/shuttle`)

A Blue Iris style shuttle slider in a bar under the video: paused in the
middle, forward to the right, reverse to the left, at 1, 2, 4, 8 and 16x.
It stays where it is left. To drop the feature, drop this commit; nothing
else depends on it.

- Logic: `web/src/hooks/use-shuttle.ts`. UI:
  `web/src/components/player/ShuttleSlider.tsx`. The only upstream file
  touched outside `RecordingView` is `DynamicVideoController.ts`, which gains
  a `getPlayer()` accessor.
- **Forward** sets the `<video>` element's `playbackRate` and the
  `playbackRate` overlay state, which `HlsVideoPlayer` reapplies whenever its
  source reloads and shows in its speed menu.
- **Reverse:** browsers can't play video backwards, so reverse runs on preview
  images instead.
  - The view's `currentTime` steps back on a `requestAnimationFrame` clock, committed every 100ms.
  - `shuttle.reversing` joins the player's `isScrubbing`, and the view's scrub effect, which shows preview frames as a drag does.
  - The release-seek effect skips while reversing, the same way it skips while live.
  - Previews are 1 to 2 fps, so 1x reverse is a slideshow; 4x and up looks smooth.
- **Ending reverse:**
  - From the shuttle: seeks with `manuallySetCurrentTime`, paused or playing, after the player has left scrubbing mode.
  - Grabbing the timeline handle hands over to the drag.
  - Reaching the start of the view's range pauses there.
- **What the shuttle shows** follows the player's own `play`, `pause` and
  `ratechange` events, so the player's buttons, its speed menu and
  hotkeys move the slider. Pauses the view causes itself are ignored: a drag,
  live, reverse, or a chunk ending.
- **Live:** the slider reads "Live". Right of the middle does nothing (live
  is real time). Left leaves live and rewinds from the live edge. Forward
  playback that runs into the newest footage goes live as before.
- **Layout:** the camera area (`cameraLayoutRef`) is now a column, and the
  bar sits below the player column. `useHeightBased` subtracts the bar's
  measured height, as it does for the preview row.
- Disabled in export and debug replay modes.
- Test ids: `shuttle` (with `data-rate`: a number, or `live`) and
  `shuttle-label`. Strings: `views/events` `shuttle.*`. Tests: the
  "Recording shuttle" cases in `recording-live-edge-playback.spec.ts`.

## 4. Scrubbing fixes (commits 6 and 7)

- **Newest frame** (`PreviewPlayer.tsx`, `PreviewFramesController.scrubToTimestamp`):
  when the scrub time is past the newest cached frame, show that newest frame
  if it is within `NEWEST_FRAME_REACH_S = 60` seconds. Before, the lookup
  found nothing and an older image stayed up. Most visible when zoomed in.
  The backend caches a frame about once per second with motion, and at least
  once per 30s without motion (`frigate/output/preview.py`,
  `PreviewRecorder.should_write_frame`), so a still scene shows the same
  frame for up to 30s. That is normal.
- **Trailing drag flush** (`web/src/hooks/use-draggable-element.ts`): the drag
  handler commits the handle time at most every `DRAG_STATE_COMMIT_MS = 100`
  ms and holds newer values in `pendingDragTimeRef`. Upstream only flushed the
  held value on the next move or on release, so a handle that stopped moving
  after a fast move left the preview minutes behind. The fork schedules one
  `setTimeout` for the end of the window (`trailingCommitRef`) that calls the
  latest setter through `setDraggableElementTimeRef`. It is cleared on mouseup
  and on unmount. This is an upstream bug, present in 0.18.0 too.

## 5. Backend: preview frames stop after startup (commit 8)

### Symptom

Scrubbing showed images only for the first few seconds after a container
start. All cameras' newest cached preview frame stopped advancing about 10s
after startup, with nothing in the logs. Recordings were unaffected.

### Root cause, a chain of four problems

1. Upstream #24644 ("Keep frame shared memory mapped", in `dev`, not in 0.18.x)
   makes frame readers keep every camera frame slot mapped. Each mapped
   `SharedMemory` holds **two** descriptors (the segment and mmap's duplicate).
   The output process reads every camera: 11 cameras x up to 50 slots x 2 is
   about 1100 descriptors.
2. `set_file_limit()` (`frigate/util/services.py`) raises the soft limit, but
   it runs in `FrigateApp.start()` in the main process only. In the fork's
   upstream base, `mp.Manager()` at the top of `main()` had already started
   the forkserver every child is forked from, so all children kept the
   container's soft limit of 1024 (containerd 2.x default).
3. `SharedMemoryFrameManager.get()` (`frigate/util/image.py`) only caught
   `FileNotFoundError`. The `OSError: [Errno 24] Too many open files` escaped
   and ended the output loop. Python's `SharedMemory.__init__` also
   **unlinks the segment** when mapping fails, even when only opening an
   existing one, so the failed read deleted that camera slot for every other
   process.
4. The dead loop left the process alive on its non-daemon jsmpeg and birdseye
   threads, so the watchdog (`frigate/watchdog.py`, which only checks
   `is_alive()`) never restarted it. The traceback sat in the child's block
   buffered stderr (`frigate/log.py`, `reopen_std_streams`), which is only
   flushed after those threads exit, so nothing was logged.

### The fix

| File | Change |
|---|---|
| `frigate/__main__.py` | Call `set_file_limit()` first in `main()`, before `mp.Manager()`, so the forkserver and every child inherit the higher limit (65536 by default, env `SOFT_FILE_LIMIT`) |
| `frigate/util/image.py` | `UntrackedSharedMemory` sets `_opening_existing` during `__init__` when `create=False`, and `unlink()` is a no-op while it is set, so a failed open can't delete the slot. `SharedMemoryFrameManager.get()` and `write()` catch `OSError`/`ValueError` and return `None`; `get()` warns once per slot (`_map_failures_logged`), then logs at debug |
| `frigate/output/output.py` | `OutputProcess.run()` wraps the old body (now `_run()`). On an unexpected exception it logs with `logger.exception` and calls `os._exit(1)`, so the watchdog restarts the process |
| `frigate/log.py` | Children reopen stdout/stderr with `buffering=1` (line buffered), so a crashed child's traceback reaches the log |
| `frigate/test/test_output_frame_map_errors.py` | 8 tests covering all of the above, each failing before the fix |

### Interaction with newer upstream

Upstream #24635 (in v0.18.1, merged into `dev` on 2026-10-15)
changed `main()` to `mp.get_context("fork").Manager()`, which delays the
forkserver until the first worker process, after `set_file_limit()` has run.
That independently fixes cause 2. When rebasing, `frigate/__main__.py` will
conflict: keep upstream's fork context `Manager()`; keeping the early
`set_file_limit()` call too is harmless. The branch has carried this
resolution since it was rebased onto `62ca5b25e`. Causes 3 and 4 and the unlink
problem are not fixed upstream as of 2026-10-15.

### Verify on the server

```bash
C=frigate; P=$(pgrep -f '^frigate.output')   # C: your container name
grep "open files" /proc/$P/limits     # expect 65536, not 1024
docker exec $C ls /tmp/cache/preview_frames \
  | sed -nE 's/^preview_(.*)-([0-9]+)\.[0-9]*\.webp$/\1 \2/p' \
  | awk -v now=$(date +%s) '{if($2>t[$1])t[$1]=$2} END{for(c in t) printf "%-20s %ds ago\n", c, now-t[c]}'
# expect every camera at a few seconds or less (30s or less before commit 16)
```

Confirmed on a real 11-camera install on 2026-10-15.

### Preview frames every second (commit 16)

**Symptom.** Scrubbing, and the shuttle's reverse, showed one frame every 30s
or nothing at all, often in slots where the main (HD) stream was recorded.

**Causes found.**

1. `PreviewRecorder.should_write_frame` (`frigate/output/preview.py`) only
   wrote a frame (at 1 fps, 2 with a moving car) while there were motion
   boxes or *active* objects, else one every 30s. A stationary object (a
   parked car, a person standing still) is not active, but it still keeps
   the main stream recording as a detection. So exactly those HD slots got
   30s previews. Motion and objects come from the detect stream; which
   streams are recorded doesn't change preview generation.
2. `PreviewFramesController` (`web/src/components/player/PreviewPlayer.tsx`)
   only finishes a seek in the image's `onLoad`. A frame that failed to load
   (listed, then deleted from the cache when the hourly mp4 was written)
   never finished, so every later scrub only queued itself: the preview froze
   until the view was reopened.
3. Not fixed, worth knowing: when the output process falls behind, a frame's
   shared memory slot is reused before it is read, `get()` returns `None`
   and the frame is skipped for previews too (`frigate/output/output.py`).
   Many in a row log `Failed to retrieve many frames ... consider increasing
   SHM size`.

**Fix.**

- `should_write_frame` writes a frame every second (2 per second with a
  moving car) regardless of motion. The first frame after start now also
  sets `last_output_time`, so a second frame can't follow 0.2s later.
- The frames player has `onError`: the failed frame goes into
  `failedFrames` and is skipped from then on, a pending scrub carries on,
  and otherwise the last frame that loaded (`lastLoadedSrc`; `naturalWidth >
  0`, since `complete` is also true for a broken image) is shown again.

**Costs.** About 3600 cached frames per camera per hour instead of a few
hundred, in `/tmp/cache/preview_frames` (usually tmpfs, so RAM): roughly
5 to 15 KB each, 20 to 55 MB per camera before the hourly mp4 replaces them.
The hourly mp4 keeps its bitrate target, so its size is about the same; a
still hour now spends that budget on 3600 frames instead of 120, and gets a
keyframe every 40s instead of every 20 minutes. Event GIFs for the current
hour play each cached frame for 0.12s, so still stretches inside an event
now play at a steady speed.

**Check on the server.**

```bash
C=frigate   # your container name
# frames per camera in the last 5 minutes: expect about 300 each
docker exec $C ls /tmp/cache/preview_frames \
  | sed -nE 's/^preview_(.*)-([0-9]+)\.[0-9]*\.webp$/\1 \2/p' \
  | awk -v since=$(( $(date +%s) - 300 )) '$2>=since{n[$1]++} END{for(c in n) printf "%-20s %d\n", c, n[c]}'
# cache size (tmpfs): watch it near the end of an hour
docker exec $C sh -c 'df -h /tmp/cache; du -sh /tmp/cache/preview_frames'
# frames dropped because the output process fell behind
docker logs $C 2>&1 | grep -c "Failed to retrieve many frames"
```

## 6. Tests

### Frontend e2e (Playwright, `web/e2e/`)

| Spec | Covers |
|---|---|
| `specs/recording-scrub-preview.spec.ts` | Preview follows a held handle, also after the edge grows; a tick doesn't drop a held handle; newest frame fallback; preview catches up when the handle stops; the edge keeps growing after release; a frame that fails to load (404) doesn't freeze the preview. Desktop and mobile |
| `specs/camera-view.spec.ts` | A dashboard tile and a `/#camera` link open the Camera view live (handle reads Live, stream plays); Back returns to the dashboard; Controls opens the classic page; Desktop and mobile |
| `specs/recording-live-handoff.spec.ts` | Live mode: releasing at the top plays live in the view (loading notice, then playing, unmuted, URL unchanged, stream connected while still held); releasing lower stays; leaving the zone cancels; dragging down leaves live; a press without a drag stays live; a timeline tap leaves live; the scroll wheel zooms the live stream. Desktop and mobile, plus a real touch drag through Chromium's DevTools protocol and the live edge marker position |
| `specs/recording-live-edge-playback.spec.ts` | Real HLS playback through hls.js: playback that runs into the newest footage carries on live; a paused player stays paused; playback continues from the playhead across a tick. Desktop and mobile |
| `helpers/live-stream-mocker.ts` | Fake go2rtc MSE socket that streams `fixtures/media/live-3s.mp4` (3s 320x180 H.264 baseline, fragmented, codecs `avc1.42C01E`), so a live player really plays. Media goes out on `release()`; the clip is short, so release it once the player should be showing. Use with `LIVE_STREAM_CONFIG`, which restreams front_door through go2rtc |
| `fixtures/media/recording-2s.mpegts` | 48 KB, 2s, 320x180 H.264 MPEG-TS segment used by the playback spec. The mock serves a playlist and coverage that grow with the requested window, repeating this segment with `EXT-X-DISCONTINUITY` |
| `specs/preview-rollover.spec.ts` | Upstream spec; its frames mock now returns the requested camera's frames like the real endpoint |

Conventions in these specs:

- The page clock is pinned with `page.clock.install({ time: NOW })`,
  `NOW = new Date(2026, 8, 2, 12, 30, 0)`. The recording view only spans the
  current day, so runs just after midnight broke the tests before this.
- Wait for `[role="scrollbar"] .cursor-grabbing` (`waitForDragStart`) before
  moving a dragged handle, and for the `video` element before dragging.
- Zoom in with the zoom button `div.absolute.z-30 > button` (nth 1).

Run from `web/` (Node 20):

```bash
npm run e2e:build && npm run e2e        # full suite
npx playwright test --config e2e/playwright.config.ts e2e/specs/recording-live-edge-playback.spec.ts
npx tsc --noEmit && npm run lint && npm run e2e:lint
```

Last full run (2026-10-15, after live zoom): 687 passed, 0 failed, 185
skipped (the skips are the desktop/mobile split, by design). An earlier
run had one load flake in `live-webrtc-availability.spec.ts` (a dashboard
menu test that doesn't open a camera; 30 of 30 on rerun).
Known upstream flake: `masonry-live-grid.spec.ts` "tiles render at their
camera's natural aspect ratio" fails about 1 run in 3, on unmodified
upstream `dev` too.

### Backend unit tests

`python3 -u -m unittest frigate.test.test_output_frame_map_errors
frigate.test.test_preview_recorder` (the second covers commit 16's frame
rate: still scene, stationary object, motion, moving car). Upstream
runs these inside the dev container. On a machine without Docker or system
pip, use a throwaway venv:

```bash
V=/tmp/frigate-venv
python3 -m venv --without-pip $V
curl -sSfL -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py && $V/bin/python -I /tmp/get-pip.py
$V/bin/pip install numpy opencv-python-headless unidecode ws4py pyzmq requests \
  pydantic ruamel.yaml psutil py3nvml peewee onnxruntime setproctitle ruff mypy
echo 'VERSION = "0.19.0-dev"' > frigate/version.py   # gitignored, normally made by `make version`
$V/bin/python -u -m unittest frigate.test.test_output_frame_map_errors
```

Importing `frigate.__main__` (one test does) needs most of
`docker/main/requirements-wheels.txt`. Install missing modules by name as
import errors appear. Never `pip install frigate`: that is an unrelated PyPI
package. `norfair` needs `--no-deps` without a compiler. The birdseye tests
need `/labelmap.txt` from the image and can't run outside it.

## 7. Updating to a new upstream version

The fork is developed against upstream `dev` (the 0.19 cycle). A trial
cherry-pick of all eight commits onto `v0.18.1` on 2026-10-15 applied only
commits 1 and 2 cleanly. The others conflict, because `dev` reworked
`DynamicVideoPlayer.tsx` (source anchoring, the load governor), the
`SharedMemoryFrameManager`, and the e2e harness after 0.18. So:

- **To follow `dev`:** rebase onto `upstream/dev` whenever you want newer
  upstream work.
- **To follow releases:** once upstream tags `v0.19.0`, rebase onto that tag,
  and from then on onto each release tag. Porting to 0.18.x would mean
  rewriting most of the commits and isn't worth it.

### Procedure

```bash
cd ~/claude/frigate
git checkout mods && git pull
git tag mods-before-<new-version> && git push origin mods-before-<new-version>   # backup
OLD_BASE=$(git merge-base mods upstream/dev)   # before fetching, so it's the current base
git fetch upstream --tags
git checkout -b mods-next mods
git rebase --onto upstream/dev $OLD_BASE   # or --onto v0.19.x for a release tag
```

(A branch named `mods/<something>` can't exist next to `mods`, which is why
the work branch is `mods-next`.)

Resolve conflicts commit by commit, using sections 3 to 5 for the intent of
each change. Known hot spots:

| File | Expect | Resolution intent |
|---|---|---|
| `frigate/__main__.py` | Conflict with #24635 | Keep `set_file_limit()` first, then upstream's `mp.get_context("fork").Manager()`. Then in `test_output_frame_map_errors.py`, `test_limit_is_raised_before_the_manager_starts` must patch `frigate_main.mp.get_context` with `return_value=SimpleNamespace(Manager=manager)` instead of patching `mp.Manager` |
| `DynamicVideoPlayer.tsx` | Upstream changes often | Keep `builtSourceRef`, `extendsSource`, `resumePlaybackRef`, the paused-rebuild branch in `onPlayerLoaded`, and the `getProgress >= after` guard |
| `RecordingView.tsx` | Upstream changes often | `effectiveTimeRange` must reach every data-dependent consumer; check any new uses of `timeRange`. Keep the live mode block (`liveAllowed`, `goLive`, `leaveLive`, `pinLiveTime`, the warm-up), `onRecordingClipEnded`, the `isLive` guard in the release-seek effect, `isScrubbing ... || isLive`, and in `Timeline` the stable `onHandlebarDraggingChange`, the hot zone listeners and `LiveEdgeMarker` |
| `LivePlayer.tsx` | Upstream changes often | `RecordingLivePlayer` relies on its props (`showStillWithoutActivity`, `playAudio`, `onLiveAspectChange` as the ready signal, `onError`); check them when it changes |
| `MotionReviewTimeline.tsx` | Rare | `LiveEdgeMarker` copies its track layout (`+ 2 * segmentDuration`, 8px segments); update it if that changes. Keep the `handlebarLabel` pass-through |
| `ReviewTimeline.tsx` | Occasional | Keep the `handlebarLabel` prop: hide the time div and render the label when set |
| `Live.tsx` | Occasional | Keep the redirect effect to `/review` with `live: true` and the `?controls` escape that renders `LiveCameraView` |
| `types/record.ts` | Rare | Keep `RecordingStartingPoint.live` |
| Upstream live specs | When they change | Opens of the classic page use `/?controls#camera`; tile clicks expect `/review` |
| `use-draggable-element.ts` (handle limits) | If upstream changes the top clamp | Re-check `LIVE_HOT_ZONE_PX` against the new limit; the handoff tests catch a mismatch |
| `PreviewPlayer.tsx` | Occasional | Keep `keepPreviousData` with the camera filter, and the controller memo deps |
| `use-draggable-element.ts` | Rare | If upstream fixes the trailing flush itself, drop commit 7 |
| `frigate/util/image.py` | Likely when #24644 follow-ups land | Keep `_opening_existing` and the `OSError`/`ValueError` handling unless upstream handles them |

**Trial on 2026-10-15:** all 21 fork commits rebased onto upstream `dev`
`16a377233` (38 commits newer than the base) with one conflict, the
`frigate/__main__.py` one above, plus the matching test adjustment. After
that the type check, the backend tests (30) and the fork's e2e specs plus
`live.spec.ts` (56) all passed. So a rebase onto 0.19 is expected to be
mostly mechanical unless upstream reworks `RecordingView.tsx`,
`DynamicVideoPlayer.tsx` or the timeline components.

**Rebase on 2026-10-15:** after v0.18.2 (two security fixes) was merged
into `dev`, `mods` was rebased onto `62ca5b25e` (41 commits newer than
`b79e04397`, including all of v0.18.1 and v0.18.2) with the same single
conflict. The type check, lint, the fork's backend tests and the full e2e
suite (686 passed, one go2rtc settings flake that passed 50 of 50 on rerun)
passed.

Releases on the 0.18 branch reach `dev` through a merge some days later.
To check that a new release is in the base:
`git fetch upstream --tags && git merge-base --is-ancestor v0.18.<n> mods && echo included`.

Before each change is dropped, check whether upstream fixed it:
`git log upstream/dev --oneline -- <file>` and read the diffs.

### Verify before deploying

1. `npx tsc --noEmit`, `npm run lint`, `npm run e2e:lint` in `web/`.
2. The two fork e2e specs, then the full e2e suite.
3. `frigate.test.test_output_frame_map_errors` and
   `test_shared_memory_frame_manager`.
4. Build an image, deploy it, then run the server check in section 5 and
   test in the browser: scrub near now, play to the top and wait 30s, pause
   across a tick, hold the handle still after a fast drag.
5. When all is well, move `mods` to the new history and publish it
   (`git checkout mods && git reset --hard mods-next && git push --force-with-lease origin mods`),
   delete `mods-next`, and update the base commit in this file's
   "Orientation" table. Other clones then need
   `git fetch origin && git reset --hard origin/mods`.

## 8. Diagnostics toolbox

Run on the Docker host. `frigate` stands for your container name.

- **Preview frame freshness and file limit:** see section 5.
- **What a stuck Frigate process is doing:** install py-spy on the host
  (`sudo apt install pipx && pipx install py-spy`), then
  `sudo ~/.local/bin/py-spy dump --pid $(pgrep -f '^frigate.output') --locals`.
  A main thread in `threading._shutdown` under `_bootstrap` means its `run()`
  already ended; `exitcode: 1` in `_bootstrap`'s locals means it raised.
- **A traceback lost in a stuck child's stderr buffer:** read it out of
  process memory with a read-only script that scans `/proc/<pid>/maps` and
  `/proc/<pid>/mem` for `  File "...", line N, in ...` lines (needs sudo). The
  line-buffering change should make this unnecessary from now on.
- **Process thread states without py-spy:** `/proc/<pid>/task/*/wchan`.
- **Logs:** `docker logs frigate 2>&1 | grep -iE "Traceback|Unable to map|Output process stopped"`.

## 9. Checkpoints

Known-good states of the fork are marked with annotated git tags, named
`v<upstream version>-mods.<n>`: the upstream version the fork is based on,
then a fork counter that restarts at 1 for each new upstream version. List
them with `git tag -l 'v*-mods.*' -n20`, and roll back to one with
`git checkout -B mods <tag>` (then rebuild).

| Tag | Upstream base | Contents |
|---|---|---|
| `v0.19.0-dev-mods.1` | `dev` at `b79e04397` | Live edge pieces 1 to 3 (in-view live mode), scrub fixes, preview frame backend fix, FORK.md. Verified on a real install 2026-10-15 |
| `v0.19.0-dev-mods.2` | `dev` at `b79e04397` | Adds the Camera view (camera opens go straight to live in the recording view, Controls button for the classic page), "Live" on the handle, zoom and pan on the live stream. Verified on a real install 2026-10-15 |
| `v0.19.0-dev-mods.3` | `dev` at `62ca5b25e` | Same fork changes as mods.2, rebased onto `dev` after it merged v0.18.2, so it includes every fix in v0.18.1 and v0.18.2 (security fixes, MSE buffer trim fix). Verified on a real install 2026-10-15 |

Tag a new checkpoint after a change has been verified on a real install:
`git tag -a v<version>-mods.<n> -m "<summary>" && git push origin v<version>-mods.<n>`,
then add a row here. On GitHub the tag shows under Releases > Tags; a
Release page can be made from it in the web UI.

## 10. Open items

- **15s reload hitch:** each tick rebuilds the HLS source. If a hitch is
  noticeable while playing near the live edge, defer reloads until playback
  nears the end of the loaded footage.
- **Upstream reporting:** the descriptor exhaustion and silent output process
  death affect anyone on upstream `dev` with about 10+ cameras. Not reported;
  waiting on the maintainer's decision.
