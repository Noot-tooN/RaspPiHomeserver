import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from service_status import publish

class ServiceStatusTests(unittest.TestCase):
    def test_atomic_snapshot_retains_concrete_failure_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            with patch.dict(os.environ, RASPPI_STATUS_FILE=str(path), INVOCATION_ID='first'):
                publish('unhealthy', 'browser-command-timeout', 3)
                publish('failed', 'health_checks_failed')
            with patch.dict(os.environ, RASPPI_STATUS_FILE=str(path), INVOCATION_ID='second'):
                publish('starting', 'page_loading')
            report = json.loads(path.read_text())
            self.assertEqual(report['invocation'], 'second')
            self.assertEqual(report['phase'], 'starting')
            self.assertEqual(report['last_failure']['code'], 'browser-command-timeout')
            self.assertFalse(path.with_suffix('.tmp').exists())

    def test_unwritable_status_never_stops_recovery(self):
        with patch.dict(os.environ, RASPPI_STATUS_FILE='/does-not-exist/status.json'):
            publish('healthy', 'healthy')
