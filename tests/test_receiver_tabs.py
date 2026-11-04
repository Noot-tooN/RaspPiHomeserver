"""Receiver ownership survives Brave session restoration without clearing storage."""

import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from youtube_receiver import (
    TV_URL, close_other_pages, create_receiver_page, get_tab, initialize_receiver,
)


class FakeBrowser:
    def __init__(self):
        self.targets = [{"type": "page", "targetId": f"restored-{i}"} for i in range(6)]
        self.targets.append({"type": "service_worker", "targetId": "worker"})
        self.calls = []

    async def call(self, method, params=None):
        params = params or {}
        self.calls.append((method, params))
        if method == "Target.createTarget":
            self.targets.append({"type": "page", "targetId": "owned"})
            return {"targetId": "owned"}
        if method == "Target.getTargets":
            return {"targetInfos": list(self.targets)}
        if method == "Target.closeTarget":
            self.targets = [t for t in self.targets if t["targetId"] != params["targetId"]]
            return {"success": True}
        return {}


class ReceiverTabTests(unittest.IsolatedAsyncioTestCase):
    async def test_restored_pages_close_before_injection_and_navigation(self):
        browser = FakeBrowser()
        target_id = await create_receiver_page(browser)
        # Use the same recorder for page commands to assert the ordering across
        # both connections. No storage-clearing or navigation of restored pages.
        await initialize_receiver(browser, "name override")
        self.assertEqual(target_id, "owned")
        self.assertEqual(browser.targets, [
            {"type": "service_worker", "targetId": "worker"},
            {"type": "page", "targetId": "owned"},
        ])
        self.assertEqual(browser.calls, [
            ("Target.createTarget", {"url": "about:blank"}),
            ("Target.getTargets", {}),
            *[("Target.closeTarget", {"targetId": f"restored-{i}"}) for i in range(6)],
            ("Page.enable", {}),
            ("Page.addScriptToEvaluateOnNewDocument", {"source": "name override"}),
            ("Page.navigate", {"url": TV_URL}),
        ])

    async def test_late_restored_tab_closes_without_reloading_owned_page(self):
        browser = FakeBrowser()
        target_id = await create_receiver_page(browser)
        browser.calls.clear()
        browser.targets.append({"type": "page", "targetId": "late"})
        await close_other_pages(browser, target_id)
        self.assertEqual(browser.calls, [
            ("Target.getTargets", {}), ("Target.closeTarget", {"targetId": "late"}),
        ])
        browser.calls.clear()
        await close_other_pages(browser, target_id)
        self.assertEqual(browser.calls, [("Target.getTargets", {})])

    async def test_missing_owned_page_fails_without_controlling_another_page(self):
        browser = FakeBrowser()
        with self.assertRaisesRegex(RuntimeError, "Receiver page disappeared"):
            await close_other_pages(browser, "missing")
        self.assertEqual(browser.calls, [("Target.getTargets", {})])

    def test_helpers_reject_ambiguous_tabs_and_startup_selects_its_target(self):
        tabs = [{"id": "restored", "type": "page"}, {"id": "owned", "type": "page"},
                {"id": "worker", "type": "service_worker"}]
        def response(*args, **kwargs):
            return io.StringIO(json.dumps(tabs))
        with patch("youtube_receiver.urllib.request.urlopen", side_effect=response):
            with self.assertRaisesRegex(ValueError, "exactly one"):
                get_tab()
            self.assertEqual(get_tab("owned"), tabs[1])
            with self.assertRaises(ValueError):
                get_tab("missing")
            tabs.pop(0)
            self.assertEqual(get_tab(), tabs[0])
            tabs.pop(0)
            with self.assertRaises(ValueError):
                get_tab()


if __name__ == "__main__":
    unittest.main()
