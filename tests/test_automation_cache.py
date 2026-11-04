import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('cache', Path(__file__).parents[1] / 'scripts/publish_cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheTests(unittest.TestCase):
    def test_transport_rewrite_preserves_signed_fields(self):
        text = 'StorePath: /nix/store/hash-app\nURL: nar/abc.nar.xz\nNarHash: sha256:abc\nNarSize: 42\nReferences: \nSig: key:signature\n'
        result, name = cache.flatten_narinfo(text)
        self.assertEqual(name, 'abc.nar.xz')
        self.assertEqual(result.replace('URL: abc.nar.xz', 'URL: nar/abc.nar.xz'), text)

    def test_reject_unexpected_archive_paths(self):
        for url in ('https://example.com/secret', '../secret', 'nar/../secret', 'nar/file.txt'):
            with self.assertRaises(ValueError):
                cache.flatten_narinfo('URL: ' + url)
