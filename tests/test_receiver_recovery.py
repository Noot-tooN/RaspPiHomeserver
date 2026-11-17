import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from youtube_receiver import CDP, CDPTimeout, monitor_receiver


class ReceiverRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_command_timeout_names_method_without_exposing_parameters(self):
        socket = SimpleNamespace(send=AsyncMock(), recv=AsyncMock())

        async def blocked():
            await asyncio.Future()
        socket.recv.side_effect = blocked
        with self.assertRaisesRegex(CDPTimeout, "^Browser command timed out: Page.navigate$"):
            await CDP(socket, timeout=0.01).call("Page.navigate", {"url": "private-data"})

    async def test_longer_startup_budget_allows_slow_browser_command(self):
        async def delayed_response():
            await asyncio.sleep(0.02)
            return '{"id":1,"result":{"ok":true}}'
        socket = SimpleNamespace(send=AsyncMock(), recv=AsyncMock(side_effect=delayed_response))
        self.assertEqual(await CDP(socket, timeout=0.2).call("Page.navigate"), {"ok": True})

    async def test_late_reply_from_timed_out_command_does_not_poison_next_probe(self):
        async def blocked():
            await asyncio.Future()
        socket = SimpleNamespace(send=AsyncMock(), recv=AsyncMock(side_effect=blocked))
        cdp = CDP(socket, timeout=0.01)
        with self.assertRaises(CDPTimeout):
            await cdp.call("Runtime.evaluate")
        socket.recv.side_effect = [
            '{"id":1,"result":{"stale":true}}',
            '{"id":2,"result":{"healthy":true}}',
        ]
        self.assertEqual(await cdp.call("Runtime.evaluate"), {"healthy": True})

    async def test_monitor_tolerates_one_timeout_resets_and_bounds_persistent_failure(self):
        healthy = {"result": {"value": json.dumps({
            "host": "www.youtube.com", "ready": "complete", "textLength": 100,
        })}}
        cdp = SimpleNamespace(call=AsyncMock(side_effect=[
            CDPTimeout(), healthy, CDPTimeout(), CDPTimeout(), CDPTimeout(),
        ]))
        browser = SimpleNamespace(call=AsyncMock(return_value={
            "targetInfos": [{"targetId": "owned", "type": "page"}],
        }))
        log = io.StringIO()
        with patch("youtube_receiver.asyncio.sleep", new_callable=AsyncMock), \
             patch("youtube_receiver.sys.stderr", log):
            with self.assertRaisesRegex(RuntimeError, "three consecutive"):
                await monitor_receiver(browser, cdp, "owned", SimpleNamespace(returncode=None))
        self.assertEqual(cdp.call.await_count, 5)
        self.assertEqual(log.getvalue().count("health check 1/3"), 2)
        self.assertIn("health check recovered", log.getvalue())

    async def test_dead_browser_does_not_wait_three_health_checks(self):
        with patch("youtube_receiver.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaisesRegex(RuntimeError, "Browser exited"):
                await monitor_receiver(None, None, "owned", SimpleNamespace(returncode=1))


if __name__ == "__main__":
    unittest.main()
