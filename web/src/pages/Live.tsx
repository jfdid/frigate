import { useFullscreen } from "@/hooks/use-fullscreen";
import useKeyboardListener from "@/hooks/use-keyboard-listener";
import { useHashState, useSearchEffect } from "@/hooks/use-overlay-state";
import { useUserPersistedOverlayState } from "@/hooks/use-overlay-state";
import { FrigateConfig } from "@/types/frigateConfig";
import LiveBirdseyeView from "@/views/live/LiveBirdseyeView";
import LiveCameraView from "@/views/live/LiveCameraView";
import LiveDashboardView from "@/views/live/LiveDashboardView";
import { useTranslation } from "react-i18next";

import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { RecordingStartingPoint } from "@/types/record";
import useSWR from "swr";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import { useHasFullCameraAccess } from "@/hooks/use-has-full-camera-access";

function Live() {
  const { t } = useTranslation(["views/live"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const hasFullCameraAccess = useHasFullCameraAccess();

  // selection

  const [selectedCameraName, setSelectedCameraName] = useHashState();
  const [cameraGroup, setCameraGroup, loaded] = useUserPersistedOverlayState(
    "cameraGroup",
    "default" as string,
  );

  useSearchEffect("group", (cameraGroup) => {
    if (config && cameraGroup && loaded) {
      const group = config.camera_groups[cameraGroup];

      if (group) {
        setCameraGroup(cameraGroup);
        // return false so that url cleanup doesn't occur here.
        // will be cleaned up by usePersistedOverlayState in the
        // camera group selector so that the icon switches correctly
        return false;
      }

      return true;
    }

    return false;
  });

  // fullscreen

  const mainRef = useRef<HTMLDivElement | null>(null);

  const { fullscreen, toggleFullscreen, supportsFullScreen } =
    useFullscreen(mainRef);

  useKeyboardListener(["f"], (key, modifiers) => {
    if (!modifiers.down) {
      return true;
    }

    switch (key) {
      case "f":
        toggleFullscreen();
        return true;
    }

    return false;
  });

  // document title

  useEffect(() => {
    if (selectedCameraName) {
      const capitalized = selectedCameraName
        .split("_")
        .filter((text) => text)
        .map((text) => text[0].toUpperCase() + text.substring(1));
      document.title = t("documentTitle.withCamera", {
        camera: capitalized.join(" "),
      });
    } else if (cameraGroup && cameraGroup != "default") {
      document.title = t("documentTitle.withCamera", {
        camera: `${cameraGroup[0].toUpperCase()}${cameraGroup.substring(1)}`,
      });
    } else {
      document.title = t("documentTitle.default", { ns: "views/live" });
    }
  }, [cameraGroup, selectedCameraName, t]);

  // settings

  const allowedCameras = useAllowedCameras();

  const includesBirdseye = useMemo(() => {
    // Users without access to all cameras should not have access to birdseye
    if (!hasFullCameraAccess) {
      return false;
    }

    if (
      config &&
      Object.keys(config.camera_groups).length &&
      cameraGroup &&
      config.camera_groups[cameraGroup] &&
      cameraGroup != "default"
    ) {
      return config.camera_groups[cameraGroup].cameras.includes("birdseye");
    } else {
      return false;
    }
  }, [config, cameraGroup, hasFullCameraAccess]);

  const cameras = useMemo(() => {
    if (!config) {
      return [];
    }

    if (
      Object.keys(config.camera_groups).length &&
      cameraGroup &&
      config.camera_groups[cameraGroup] &&
      cameraGroup != "default"
    ) {
      const group = config.camera_groups[cameraGroup];
      return Object.values(config.cameras)
        .filter(
          (conf) => conf.enabled_in_config && group.cameras.includes(conf.name),
        )
        .filter((cam) => allowedCameras.includes(cam.name))
        .sort((aConf, bConf) => aConf.ui.order - bConf.ui.order);
    }

    return Object.values(config.cameras)
      .filter((conf) => conf.ui.dashboard && conf.enabled_in_config)
      .filter((cam) => allowedCameras.includes(cam.name))
      .sort((aConf, bConf) => aConf.ui.order - bConf.ui.order);
  }, [config, cameraGroup, allowedCameras]);

  const selectedCamera = useMemo(() => {
    if (!config || !selectedCameraName || selectedCameraName === "birdseye") {
      return undefined;
    }
    const camera = config.cameras[selectedCameraName];
    if (
      camera &&
      allowedCameras.includes(selectedCameraName) &&
      camera.enabled_in_config
    ) {
      return camera;
    }
    return undefined;
  }, [config, selectedCameraName, allowedCameras]);

  // fork: opening one camera (a dashboard tile, Birdseye, a /#camera link)
  // goes to the Camera view, the recording view in live mode, so live and
  // history are one screen. `/?controls#camera` keeps this classic live
  // page for what the Camera view lacks: PTZ, two-way talk, the toggles

  const location = useLocation();
  const navigate = useNavigate();
  const showControls = new URLSearchParams(location.search).has("controls");

  useEffect(() => {
    if (!selectedCamera || showControls) {
      return;
    }

    navigate("/review", {
      // back from the Camera view returns to the dashboard
      replace: true,
      state: {
        severity: "alert",
        recording: {
          camera: selectedCamera.name,
          startTime: Date.now() / 1000 - 30,
          severity: "alert",
          live: true,
        } as RecordingStartingPoint,
      },
    });
  }, [selectedCamera, showControls, navigate]);

  return (
    <div className="size-full" ref={mainRef}>
      {selectedCameraName === "birdseye" &&
      hasFullCameraAccess &&
      config?.birdseye?.enabled ? (
        <LiveBirdseyeView
          supportsFullscreen={supportsFullScreen}
          fullscreen={fullscreen}
          toggleFullscreen={toggleFullscreen}
          onSelectCamera={setSelectedCameraName}
        />
      ) : selectedCamera ? (
        // redirecting to the Camera view unless the controls were asked for
        showControls && (
          <LiveCameraView
            key={selectedCameraName}
            config={config}
            camera={selectedCamera}
            supportsFullscreen={supportsFullScreen}
            fullscreen={fullscreen}
            toggleFullscreen={toggleFullscreen}
          />
        )
      ) : (
        <LiveDashboardView
          cameras={cameras}
          cameraGroup={cameraGroup ?? "default"}
          includeBirdseye={includesBirdseye}
          onSelectCamera={setSelectedCameraName}
          fullscreen={fullscreen}
          toggleFullscreen={toggleFullscreen}
        />
      )}
    </div>
  );
}

export default Live;
