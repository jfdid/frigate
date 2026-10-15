import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
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
};

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
}: RecordingLivePlayerProps) {
  const { t } = useTranslation(["views/events"]);
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
    >
      {/* pinch or scroll to zoom and drag to pan, like the recording
          player and the classic live page; kept while warming up, so a
          zoom carries across leaving and returning to live */}
      <TransformWrapper
        minScale={1.0}
        wheel={{ smoothStep: 0.005 }}
        disabled={!active}
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
    </div>
  );
}
