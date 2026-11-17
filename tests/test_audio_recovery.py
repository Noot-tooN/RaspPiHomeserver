import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import audio_recovery


class AudioRecoveryTests(unittest.TestCase):
    def probe(self, *, missing=(), transition=None, sinks="1 rasppi-dac\n2 rasppi-eq\n",
              marker=True, age=60):
        state = "\n\n".join(
            f"Id={name}.service\nActiveState=" +
            ("activating" if name == transition else "failed" if name in missing else "active") +
            f"\nActiveEnterTimestampMonotonic={int((1000-age)*1e6)}"
            for name in audio_recovery.BACKENDS + audio_recovery.PLAYERS)
        calls = []

        def run(*args):
            if args[:3] == ("systemctl", "--user", "show"):
                return state
            if args[0] == "pactl":
                if isinstance(sinks, Exception):
                    raise sinks
                return sinks
            calls.append(args)
            return ""

        with patch.object(audio_recovery, "run", side_effect=run), \
             patch.object(audio_recovery.Path, "exists", return_value=marker), \
             patch.object(audio_recovery.time, "monotonic", return_value=1000):
            audio_recovery.recover()
        return calls

    def test_healthy_playback_is_not_restarted(self):
        self.assertEqual(self.probe(), [])

    def test_dependency_failure_retries_both_receivers(self):
        self.assertEqual(self.probe(missing=audio_recovery.PLAYERS), [
            ("systemctl", "--user", "--no-block", "start",
             "rasppi-audio-ready.service", "spotify.service", "youtube-tv.service")])

    def test_missing_equalizer_output_restarts_live_filter_before_players(self):
        self.assertEqual(self.probe(sinks="1 rasppi-dac\n", missing=audio_recovery.PLAYERS), [
            ("systemctl", "--user", "--no-block", "restart", "rasppi-equalizer.service")])
        self.assertEqual(self.probe(sinks="1 rasppi-dac\n", age=10), [])

    def test_waiting_readiness_does_not_block_equalizer_repair(self):
        self.assertEqual(self.probe(sinks="1 rasppi-dac\n", transition="rasppi-audio-ready"), [
            ("systemctl", "--user", "--no-block", "restart", "rasppi-equalizer.service")])
        self.assertEqual(self.probe(transition="rasppi-equalizer"), [])

    def test_backends_recover_before_receivers(self):
        self.assertEqual(self.probe(missing=("pipewire", "rasppi-equalizer", "spotify")), [
            ("systemctl", "--user", "--no-block", "start", "pipewire.service", "rasppi-equalizer.service")])

    def test_no_playback_before_mixer_and_physical_sink_exist(self):
        self.assertEqual(self.probe(marker=False, missing=audio_recovery.PLAYERS), [])
        self.assertEqual(self.probe(sinks="1 rasppi-eq\n", missing=audio_recovery.PLAYERS), [])

    def test_in_progress_restart_is_not_replaced(self):
        self.assertEqual(self.probe(transition="youtube-tv", missing=("spotify",)), [])

    def test_failed_probe_does_not_guess_and_restart_healthy_services(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.probe(sinks=subprocess.TimeoutExpired("pactl", 5))


if __name__ == "__main__":
    unittest.main()
