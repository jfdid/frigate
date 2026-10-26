"""Tests for how often the preview recorder keeps a frame."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from frigate.output.preview import PreviewRecorder

DETECT_FPS = 5
START = 1_700_000_000.0


def make_recorder(record_enabled: bool = True) -> PreviewRecorder:
    """A recorder with just the state frame selection reads.

    The real constructor opens an inter process socket and cache folders,
    which these tests don't need.
    """
    recorder = PreviewRecorder.__new__(PreviewRecorder)
    recorder.config = SimpleNamespace(
        name="front_door",
        record=SimpleNamespace(enabled=record_enabled),
        detect=SimpleNamespace(stationary=SimpleNamespace(threshold=50)),
    )
    recorder.camera_name = "front_door"
    recorder.start_time = 0
    recorder.last_output_time = 0
    recorder.offline = False
    recorder.output_frames = []
    recorder.segment_end = START + 3600
    return recorder


def moving_object(label: str, frame_time: float) -> dict:
    return {
        "label": label,
        "motionless_count": 0,
        "position_changes": 3,
        "frame_time": frame_time,
        "false_positive": False,
    }


def stationary_object(label: str, frame_time: float) -> dict:
    return {
        "label": label,
        "motionless_count": 500,
        "position_changes": 3,
        "frame_time": frame_time,
        "false_positive": False,
    }


def feed(
    recorder: PreviewRecorder,
    seconds: int,
    objects=lambda frame_time: [],
    motion=lambda frame_time: [],
) -> list[float]:
    """Feed frames at the detect rate; return the times that were kept."""
    with patch.object(PreviewRecorder, "write_frame_to_cache"):
        for i in range(seconds * DETECT_FPS):
            frame_time = START + i / DETECT_FPS
            recorder.write_data(
                objects(frame_time), motion(frame_time), frame_time, None
            )

    return recorder.output_frames


class TestPreviewRecorderFrameRate(unittest.TestCase):
    def test_quiet_scene_keeps_a_frame_every_second(self):
        # no motion and no objects: scrubbing and reverse playback still
        # need a frame for every second of footage
        kept = feed(make_recorder(), 60)

        self.assertGreaterEqual(len(kept), 59)
        self.assertLessEqual(len(kept), 61)
        gaps = [b - a for a, b in zip(kept, kept[1:])]
        self.assertLessEqual(max(gaps), 1.0 + 1e-6)

    def test_stationary_object_keeps_a_frame_every_second(self):
        # a parked car or a person standing still keeps the main stream
        # recording as a detection, without motion boxes or active objects
        kept = feed(
            make_recorder(),
            60,
            objects=lambda frame_time: [stationary_object("person", frame_time)],
        )

        self.assertGreaterEqual(len(kept), 59)

    def test_motion_keeps_a_frame_every_second(self):
        kept = feed(make_recorder(), 60, motion=lambda frame_time: [[0, 0, 10, 10]])

        self.assertGreaterEqual(len(kept), 59)
        self.assertLessEqual(len(kept), 61)

    def test_moving_car_keeps_more_frames(self):
        # 2 fps, quantized to the detect rate: at 5 fps the first frame
        # half a second on is 0.6s after the last
        kept = feed(
            make_recorder(),
            60,
            objects=lambda frame_time: [moving_object("car", frame_time)],
        )

        self.assertGreaterEqual(len(kept), 95)
        self.assertLessEqual(len(kept), 121)

    def test_frames_never_come_faster_than_the_rate(self):
        kept = feed(make_recorder(), 30, motion=lambda frame_time: [[0, 0, 10, 10]])

        gaps = [b - a for a, b in zip(kept, kept[1:])]
        self.assertGreaterEqual(min(gaps), 1.0 - 1e-6)

    def test_recording_disabled_keeps_only_the_first_frame(self):
        kept = feed(make_recorder(record_enabled=False), 60)

        self.assertEqual(kept, [START])


if __name__ == "__main__":
    unittest.main(verbosity=2)
