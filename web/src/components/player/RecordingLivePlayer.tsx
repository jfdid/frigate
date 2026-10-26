import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { isDesktop } from "react-device-detect";
import { FaCompress, FaExpand } from "react-icons/fa";
import LivePlayer from "./LivePlayer";
import ActivityIndicator from "../indicators/activity-indicator";
import { FrigateConfig } from "@/types/frigateConfig";
import { LivePlayerError, LivePlayerMode } from "@/types/live";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import { isRestreamedStream } from "@/utils/liveTranscode";
import { cn } from "@/lib/utils";

type RecordingLivePlayerProps = {
  camera: string;
  // shown as the main player; otherwise mounted out of sight to warm up
  active: boolean;
  onReadyChange?: (ready: boolean) => void;
  fullscreen?: boolean;
  supportsFullscreen?: boolean;
  toggleFullscreen?: () => void;
};

// how long a tap shows the controls on touch devices, like the recording
// player's controls
const CONTROLS_HIDE_MS = 4000;

/**
 * The live stream shown inside the recording view at the live edge.
 *
 * Reads the same saved per-camera stream and mode preferences as the live
 * view, without the live view's adaptive stream selection: the pinned
 * stream, else the camera's first stream, in the preferred mode, falling
 * back to jsmpeg after an error. Mounted while inactive it connects muted
 * and out of sight, so switching to it doesn't wait for the stream.
 */
export default function RecordingLivePlayer({
  camera,
  active,
  onReadyChange,
  fullscreen = false,
  supportsFullscreen = false,
  toggleFullscreen,
}: RecordingLivePlayerProps) {
  const { t } = useTranslation(["views/events", "common"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const cameraConfig = config?.cameras[camera];
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [pinnedStream] = useUserPersistence<string>(`${camera}-stream`);
  const [userPreferredLiveMode] = useUserPersistence<LivePlayerMode>(
    `${camera}-preferred-live-mode`,
    "mse",
  );
  const [forceLowBandwidth] = useUserPersistence<boolean>(
    `${camera}-force-low-bandwidth`,
    false,
  );
  const [fallback, setFallback] = useState(false);

  const streamName = useMemo(() => {
    const streams = Object.values(cameraConfig?.live.streams ?? {});

    return pinnedStream && streams.includes(pinnedStream)
      ? pinnedStream
      : streams[0];
  }, [cameraConfig, pinnedStream]);

  const preferredLiveMode = useMemo<LivePlayerMode>(() => {
    const mseSupported =
      "MediaSource" in window || "ManagedMediaSource" in window;

    if (
      fallback ||
      forceLowBandwidth ||
      !config ||
      !streamName ||
      !isRestreamedStream(config, streamName)
    ) {
      return "jsmpeg";
    }

    if (userPreferredLiveMode == "webrtc") {
      return "webrtc";
    }

    return mseSupported ? "mse" : "webrtc";
  }, [config, streamName, userPreferredLiveMode, forceLowBandwidth, fallback]);

  const [ready, setReady] = useState(false);

  useEffect(() => {
    onReadyChange?.(ready);
  }, [ready, onReadyChange]);

  // a camera or mode change reconnects, so it isn't ready until it plays
  useEffect(() => {
    setReady(false);
  }, [camera, streamName, preferredLiveMode]);

  useEffect(() => {
    setFallback(false);
  }, [camera]);

  const onLiveAspectChange = useCallback(
    (aspect: number | undefined) => setReady(aspect !== undefined),
    [],
  );

  const onError = useCallback((error: LivePlayerError) => {
    if (error) {
      setFallback(true);
    }
  }, []);

  // controls: shown on hover (desktop) or on tap (touch), only while live

  const [controls, setControls] = useState(false);
  const hideControlsTimeoutRef = useRef<NodeJS.Timeout>(undefined);
  // a drag that pans a zoomed stream ends in a click, which must not toggle
  const pannedRef = useRef(false);

  const showControls = useCallback((show: boolean, autoHide: boolean) => {
    clearTimeout(hideControlsTimeoutRef.current);
    setControls(show);

    if (show && autoHide) {
      hideControlsTimeoutRef.current = setTimeout(
        () => setControls(false),
        CONTROLS_HIDE_MS,
      );
    }
  }, []);

  useEffect(() => {
    if (!active) {
      showControls(false, false);
    }
  }, [active, showControls]);

  useEffect(() => () => clearTimeout(hideControlsTimeoutRef.current), []);

  const hasControls = supportsFullscreen && toggleFullscreen != undefined;

  if (!cameraConfig || !streamName) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 z-30 flex items-center justify-center bg-black",
        // warming up: connected but not shown or clickable. Transparent
        // rather than visibility: hidden, which browsers may treat as off
        // screen and stop decoding
        !active && "pointer-events-none opacity-0",
      )}
      data-testid="recording-live-player"
      data-active={active}
      data-ready={ready}
      onMouseMove={
        isDesktop && active && hasControls
          ? () => !controls && showControls(true, false)
          : undefined
      }
      onMouseLeave={
        isDesktop && hasControls ? () => showControls(false, false) : undefined
      }
      onClick={
        !isDesktop && active && hasControls
          ? () => {
              if (pannedRef.current) {
                pannedRef.current = false;
                return;
              }

              showControls(!controls, true);
            }
          : undefined
      }
    >
      {/* pinch or scroll to zoom and drag to pan, like the recording
          player and the classic live page; kept while warming up, so a
          zoom carries across leaving and returning to live */}
      <TransformWrapper
        minScale={1.0}
        wheel={{ smoothStep: 0.005 }}
        disabled={!active}
        onPanningStart={() => {
          pannedRef.current = false;
        }}
        onPanning={() => {
          pannedRef.current = true;
        }}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", height: "100%" }}
          contentStyle={{ width: "100%", height: "100%" }}
        >
          <LivePlayer
            containerRef={containerRef}
            className="size-full"
            cameraConfig={cameraConfig}
            streamName={streamName}
            preferredLiveMode={preferredLiveMode}
            showStillWithoutActivity={false}
            useWebGL={false}
            playInBackground={false}
            playAudio={active}
            onError={onError}
            onLiveAspectChange={onLiveAspectChange}
          />
        </TransformComponent>
      </TransformWrapper>
      {active && !ready && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
          <ActivityIndicator className="text-white" />
          <div className="text-sm">{t("liveEdge.loadingStream")}</div>
        </div>
      )}
      {active && (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-destructive px-2 py-0.5 text-xs font-medium text-white">
          <span className="size-1.5 animate-pulse rounded-full bg-white" />
          {t("liveEdge.live")}
        </div>
      )}
      {active && hasControls && controls && (
        <div
          className="absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 select-none items-center gap-4 rounded-lg bg-background/60 px-4 py-2 text-primary"
          data-testid="live-controls"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="cursor-pointer"
            role="button"
            aria-label={
              fullscreen
                ? t("button.exitFullscreen", { ns: "common" })
                : t("button.fullscreen", { ns: "common" })
            }
            data-testid="live-fullscreen"
            onClick={() => {
              toggleFullscreen?.();

              if (!isDesktop) {
                showControls(true, true);
              }
            }}
          >
            {fullscreen ? <FaCompress /> : <FaExpand />}
          </div>
        </div>
      )}
    </div>
  );
}
