import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from youtube_pairing import extract_code, tv_page


class PairingTests(unittest.TestCase):
    def test_only_numeric_tv_codes_are_returned(self):
        self.assertEqual(extract_code("Settings\nLink with TV code\n012 345 678 901\nSign in"), "012345678901")
        self.assertEqual(extract_code("Link with TV code\n\u200e123\u00a0456 789 012\u200f"), "123456789012")
        for text in ("Enter the code\nABC-DEF-GHIJ", "Link with TV code\nABC-DEF-GHIJ",
                     "Home\n123 456 789 012", "Link with TV code\n123 456 789",
                     "Link with TV code\n1234567890123", "Link with TV code\nWatch 123456789012 now"):
            with self.subTest(text=text):
                self.assertIsNone(extract_code(text))

    def test_only_the_receiver_page_is_accepted(self):
        for url in ("https://www.youtube.com/tv", "https://www.youtube.com/tv#/", "https://www.youtube.com/tv/anything"):
            self.assertTrue(tv_page(url))
        for url in ("https://www.youtube.com/watch", "http://www.youtube.com/tv",
                    "https://www.youtube.com.evil.test/tv", "https://evil.test@www.youtube.com/tv", "about:blank"):
            self.assertFalse(tv_page(url))
