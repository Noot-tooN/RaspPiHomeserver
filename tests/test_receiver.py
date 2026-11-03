import json
import configparser
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from youtube_receiver import CDP, page_healthy
from prepare_wifi import render


class FakeSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        return json.dumps(next(self.messages))


class ReceiverTests(unittest.IsolatedAsyncioTestCase):
    async def test_cdp_ignores_navigation_events_and_unrelated_responses(self):
        socket = FakeSocket([
            {"method": "Page.frameNavigated", "params": {}},
            {"id": 999, "result": {"wrong": True}},
            {"id": 1, "result": {"identifier": "injected"}},
        ])
        result = await CDP(socket).call("Page.addScriptToEvaluateOnNewDocument", {"source": "test"})
        self.assertEqual(result, {"identifier": "injected"})
        self.assertEqual(socket.sent[0]["method"], "Page.addScriptToEvaluateOnNewDocument")

    async def test_cdp_error_does_not_log_response_contents(self):
        socket = FakeSocket([{"id": 1, "error": {"message": "private account data"}}])
        with self.assertRaisesRegex(RuntimeError, "^Browser command failed: Page.navigate$"):
            await CDP(socket).call("Page.navigate")

    def test_blank_or_failed_pages_are_unhealthy_but_account_chooser_is_healthy(self):
        chooser = {"host": "www.youtube.com", "ready": "complete", "textLength": 120, "label": "RaspPi"}
        self.assertTrue(page_healthy(chooser))
        for bad in ({}, dict(chooser, textLength=0), dict(chooser, host="chrome-error"),
                    dict(chooser, label="YouTube on TV"), dict(chooser, ready="loading")):
            with self.subTest(bad=bad):
                self.assertFalse(page_healthy(bad))

    def test_wifi_keyfile_roundtrip_matches_networkmanager(self):
        for ssid in ("Home Wi-Fi", "65;66;", "home\\test", "home\n[ipv4]\nmethod=off"):
            password = " test pass%word! "
            with self.subTest(ssid=ssid):
                actual = subprocess.check_output(
                    ["nmcli", "--offline", "connection", "modify", "connection.id", "rasppi-wifi"],
                    input=render(ssid, password), text=True,
                )
                reference = subprocess.check_output([
                    "nmcli", "--offline", "connection", "add", "type", "wifi",
                    "con-name", "rasppi-wifi", "ssid", ssid,
                    "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password,
                ], text=True)
                parsed = []
                for keyfile in (actual, reference):
                    value = configparser.ConfigParser(interpolation=None)
                    value.read_string(keyfile)
                    parsed.append(value)
                self.assertEqual(parsed[0]["wifi"]["ssid"], parsed[1]["wifi"]["ssid"])
                self.assertEqual(parsed[0]["wifi-security"]["psk"], parsed[1]["wifi-security"]["psk"])

    def test_wifi_password_validation(self):
        with self.assertRaises(ValueError):
            render("home", "short")
        with self.assertRaises(ValueError):
            render("a" * 33, "long-enough-password")


if __name__ == "__main__":
    unittest.main()
