"""Tests for the output process surviving frame slots it can't map.

Readers keep every frame slot mapped, and each mapping holds two descriptors
(the segment and mmap's duplicate). With many cameras that passed the 1024 soft
limit children inherited from the forkserver, and the OSError from opening the
next slot escaped get() and ended the output loop while its non-daemon jsmpeg
threads kept the process alive, so preview frames stopped for every camera.
"""

import errno
import os
import resource
import unittest
import uuid
from multiprocessing import shared_memory as _mpshm
from types import SimpleNamespace
from unittest.mock import patch

from frigate.util.image import SharedMemoryFrameManager


def _open_fd_count() -> int:
    return len(os.listdir("/proc/self/fd"))


class TestFrameManagerMapErrors(unittest.TestCase):
    def setUp(self) -> None:
        self.prefix = f"test_map_{uuid.uuid4().hex[:8]}"
        self.names: list[str] = []

    def tearDown(self) -> None:
        for name in self.names:
            try:
                _mpshm._posixshmem.shm_unlink(f"/{name}")
            except FileNotFoundError:
                pass

    def _create_slots(self, count: int, size: int) -> None:
        for i in range(count):
            # created directly so no resource tracker gets involved
            name = f"{self.prefix}_frame{i}"
            fd = _mpshm._posixshmem.shm_open(
                f"/{name}", os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600
            )
            os.ftruncate(fd, size)
            os.close(fd)
            self.names.append(name)

    def test_get_returns_none_when_out_of_descriptors(self) -> None:
        """Running out of descriptors drops the frame instead of raising."""
        self._create_slots(20, 64)
        manager = SharedMemoryFrameManager()
        # runs after the limit is restored, cleanups being last in, first out
        self.addCleanup(lambda: [manager.close(n) for n in list(manager.shm_store)])

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))
        # room for a few slots at two descriptors each, not all 20
        resource.setrlimit(resource.RLIMIT_NOFILE, (_open_fd_count() + 8, hard))

        results = [manager.get(f"{self.prefix}_frame{i}", (64,)) for i in range(20)]

        mapped = [r for r in results if r is not None]
        self.assertGreater(len(mapped), 0)
        self.assertIsNone(results[-1])

        # a reader that couldn't map a slot must not delete it from capture
        for name in self.names:
            self.assertTrue(os.path.exists(f"/dev/shm/{name}"), name)

    def test_get_returns_none_for_unsized_segment(self) -> None:
        """A segment that exists but has no size yet can't be mapped."""
        name = f"{self.prefix}_frame0"
        fd = _mpshm._posixshmem.shm_open(f"/{name}", os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.names.append(name)

        manager = SharedMemoryFrameManager()
        self.assertIsNone(manager.get(name, (64,)))
        self.assertNotIn(name, manager.shm_store)

    def test_get_logs_a_repeated_failure_once(self) -> None:
        manager = SharedMemoryFrameManager()
        error = OSError(errno.EMFILE, "Too many open files")

        with (
            patch("frigate.util.image.UntrackedSharedMemory", side_effect=error),
            patch("frigate.util.image.logger") as logger,
        ):
            for _ in range(5):
                self.assertIsNone(manager.get("cam_frame0", (64,)))

        self.assertEqual(logger.warning.call_count, 1)

    def test_write_returns_none_when_out_of_descriptors(self) -> None:
        manager = SharedMemoryFrameManager()
        error = OSError(errno.EMFILE, "Too many open files")

        with patch("frigate.util.image.UntrackedSharedMemory", side_effect=error):
            self.assertIsNone(manager.write("cam_frame_times"))


class TestOutputProcessExitsOnError(unittest.TestCase):
    def test_unexpected_error_exits_the_process(self) -> None:
        """A crashed loop must end the process so the watchdog restarts it."""
        from frigate.output.output import OutputProcess

        process = OutputProcess.__new__(OutputProcess)

        with (
            patch.object(OutputProcess, "_run", side_effect=OSError("boom")),
            patch("frigate.output.output.os._exit") as exit_mock,
            patch("frigate.output.output.logger"),
        ):
            process.run()

        exit_mock.assert_called_once_with(1)

    def test_clean_return_does_not_exit(self) -> None:
        from frigate.output.output import OutputProcess

        process = OutputProcess.__new__(OutputProcess)

        with (
            patch.object(OutputProcess, "_run", return_value=None),
            patch("frigate.output.output.os._exit") as exit_mock,
        ):
            process.run()

        exit_mock.assert_not_called()


class TestFileLimitBeforeForkserver(unittest.TestCase):
    def test_limit_is_raised_before_the_manager_starts(self) -> None:
        """Child processes inherit the open file limit when they fork, so it
        has to be raised before the manager or any worker process starts."""
        import frigate.__main__ as frigate_main

        calls: list[str] = []

        class Stop(Exception):
            pass

        def manager() -> None:
            calls.append("manager")
            raise Stop()

        with (
            patch.object(
                frigate_main,
                "set_file_limit",
                side_effect=lambda: calls.append("limit"),
            ),
            patch.object(
                frigate_main.mp,
                "get_context",
                return_value=SimpleNamespace(Manager=manager),
            ),
        ):
            with self.assertRaises(Stop):
                frigate_main.main()

        self.assertEqual(calls, ["limit", "manager"])


class TestChildStdStreams(unittest.TestCase):
    def test_child_streams_are_line_buffered(self) -> None:
        """A traceback printed by a crashed child has to reach the log even
        if the process then never exits."""
        from frigate import log

        with patch("frigate.log.os.fdopen") as fdopen, patch("frigate.log.sys"):
            log.reopen_std_streams()

        for call in fdopen.call_args_list:
            self.assertEqual(call.kwargs.get("buffering"), 1)
        self.assertEqual(fdopen.call_count, 2)


if __name__ == "__main__":
    unittest.main()
