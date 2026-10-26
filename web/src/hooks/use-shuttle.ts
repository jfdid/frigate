import { useCallback, useEffect, useRef, useState } from "react";
import { DynamicVideoController } from "@/components/player/dynamic/DynamicVideoController";
import { useOverlayState } from "./use-overlay-state";
import { useUserPersistence } from "./use-user-persistence";
import { playWithTemporaryMuteFallback } from "@/utils/videoUtil";

// the shuttle's stops, slowest to fastest; reverse uses the same speeds
export const SHUTTLE_SPEEDS = [1, 2, 4, 8, 16];

// reverse steps are committed to the view this often. The preview images
// it shows change once or twice per second of footage, so faster commits
// would only cost renders
const REVERSE_COMMIT_MS = 100;

type UseShuttleProps = {
  isLive: boolean;
  leaveLive: () => void;
  // the timeline handle is held
  scrubbing: boolean;
  currentTime: number;
  setCurrentTime: (time: number) => void;
  // reverse stops here: the start of the view's range
  earliestTime: number;
  // an explicit seek, as the view's own seek controls do
  seekTo: (time: number, play: boolean) => void;
};

/**
 * Blue Iris style shuttle for the recording view: one control for pause,
 * forward speed and reverse speed.
 *
 * Forward plays the recording player at the chosen playbackRate, shared
 * with the player's speed menu through the same overlay state. Browsers
 * can't play video backwards, so reverse steps the view's time back on a
 * frame clock while the player is in scrubbing mode, which shows preview
 * images like a timeline drag does.
 *
 * The reported rate follows the player, so the player's own controls,
 * the speed menu and a timeline drag all show on the shuttle.
 */
export function useShuttle({
  isLive,
  leaveLive,
  scrubbing,
  currentTime,
  setCurrentTime,
  earliestTime,
  seekTo,
}: UseShuttleProps) {
  const [player, setPlayer] = useState<HTMLVideoElement>();

  const onControllerReady = useCallback(
    (controller: DynamicVideoController) => setPlayer(controller.getPlayer()),
    [],
  );

  // forward speed, persisted like the player's speed menu

  const [defaultSpeed] = useUserPersistence("playbackRate", 1);
  const [, setOverlaySpeed] = useOverlayState<number>(
    "playbackRate",
    defaultSpeed ?? 1,
  );

  const applySpeed = useCallback(
    (speed: number) => {
      // the player reapplies the overlay speed whenever its source reloads
      setOverlaySpeed(speed, true);

      if (player) {
        player.playbackRate = speed;
      }
    },
    [player, setOverlaySpeed],
  );

  // reverse

  const [reverseSpeed, setReverseSpeed] = useState(0);
  const reversing = reverseSpeed > 0;
  const reversePosRef = useRef(currentTime);
  // the last time reverse put on the view. Anything else (a tap on the
  // timeline) moves reverse there instead of being stepped over
  const reverseCommittedRef = useRef(currentTime);
  // set when reverse ends by a shuttle change: whether to play from there
  const resumeAfterReverseRef = useRef<boolean | undefined>(undefined);

  // the player's state, as shown on the shuttle. Pauses the view causes
  // (a drag, live, reverse, a chunk ending) don't count as the user pausing
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const viewPausedRef = useRef(false);
  viewPausedRef.current = scrubbing || isLive || reversing;

  useEffect(() => {
    if (!player) {
      return;
    }

    const onPlay = () => setPlaying(true);
    const onPause = () => {
      if (!player.ended && !viewPausedRef.current) {
        setPlaying(false);
      }
    };
    const onRateChange = () => setSpeed(player.playbackRate);

    setPlaying(!player.paused);
    setSpeed(player.playbackRate);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ratechange", onRateChange);

    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ratechange", onRateChange);
    };
  }, [player]);

  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const earliestTimeRef = useRef(earliestTime);
  earliestTimeRef.current = earliestTime;

  useEffect(() => {
    if (!reversing || scrubbing) {
      return;
    }

    let frame: number;
    let last: number | undefined;
    let lastCommit = 0;

    const step = (now: number) => {
      const elapsed = last === undefined ? 0 : (now - last) / 1000;
      last = now;

      if (currentTimeRef.current != reverseCommittedRef.current) {
        reversePosRef.current = currentTimeRef.current;
        reverseCommittedRef.current = currentTimeRef.current;
      }

      const pos = Math.max(
        earliestTimeRef.current,
        reversePosRef.current - elapsed * reverseSpeed,
      );
      reversePosRef.current = pos;

      if (pos <= earliestTimeRef.current) {
        reverseCommittedRef.current = pos;
        setCurrentTime(pos);
        resumeAfterReverseRef.current = false;
        setReverseSpeed(0);
        return;
      }

      if (now - lastCommit >= REVERSE_COMMIT_MS) {
        lastCommit = now;
        reverseCommittedRef.current = pos;
        setCurrentTime(pos);
      }

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [reversing, reverseSpeed, scrubbing, setCurrentTime]);

  // grabbing the timeline handle takes over from reverse; the release
  // seeks and plays from the handle as usual
  useEffect(() => {
    if (scrubbing && reversing) {
      resumeAfterReverseRef.current = undefined;
      setReverseSpeed(0);
    }
  }, [scrubbing, reversing]);

  // reverse ended by a shuttle change: seek the player to where reverse
  // left the view. Runs after the player has left scrubbing mode
  useEffect(() => {
    if (reversing) {
      return;
    }

    const resume = resumeAfterReverseRef.current;
    resumeAfterReverseRef.current = undefined;

    if (resume !== undefined) {
      seekTo(currentTimeRef.current, resume);
    }
    // only when reverse ends
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reversing]);

  const setRate = useCallback(
    (rate: number) => {
      if (rate < 0) {
        if (isLive) {
          leaveLive();
        }

        if (!reversing) {
          reversePosRef.current = currentTimeRef.current;
          reverseCommittedRef.current = currentTimeRef.current;
        }

        setReverseSpeed(-rate);
        return;
      }

      if (reversing) {
        if (rate > 0) {
          applySpeed(rate);
          setSpeed(rate);
          setPlaying(true);
        } else {
          setPlaying(false);
        }

        resumeAfterReverseRef.current = rate > 0;
        setReverseSpeed(0);
        return;
      }

      // live already runs in real time; only reverse leaves it
      if (isLive || !player) {
        return;
      }

      // shown at once rather than when the player's events arrive: a
      // quick second step would otherwise start from the old position
      setPlaying(rate > 0);

      if (rate == 0) {
        player.pause();
        return;
      }

      applySpeed(rate);
      setSpeed(rate);

      if (player.paused) {
        playWithTemporaryMuteFallback(player);
      }
    },
    [isLive, leaveLive, reversing, applySpeed, player],
  );

  const rate = reversing ? -reverseSpeed : playing ? speed : 0;

  return { rate, reversing, setRate, onControllerReady };
}
