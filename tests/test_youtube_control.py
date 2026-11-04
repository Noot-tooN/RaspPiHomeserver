import json
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from youtube_control import control


class YouTubeLoadTests(unittest.IsolatedAsyncioTestCase):
    async def test_load_passes_only_video_id_as_json_to_the_existing_receiver(self):
        page = {'url': 'https://www.youtube.com/tv#/',
                'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        socket = AsyncMock()
        evaluate = AsyncMock(return_value={'accepted': True})
        with patch('youtube_control.get_tab', return_value=page), \
             patch('youtube_control.websockets.connect', return_value=socket), \
             patch('youtube_control.evaluate', evaluate):
            result = await control('load', None, '// player script', '-abcdefghij')
        self.assertEqual(result, {'accepted': True})
        expression = evaluate.call_args.args[1]
        self.assertTrue(expression.startswith('// player script\ncontrolYouTube('))
        payload = json.loads(expression.split('\ncontrolYouTube(', 1)[1][:-1])
        self.assertEqual(payload, {'action': 'load', 'videoId': '-abcdefghij'})

    async def test_invalid_video_id_never_reaches_browser_commands(self):
        page = {'url': 'https://www.youtube.com/tv',
                'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        with patch('youtube_control.get_tab', return_value=page), \
             patch('youtube_control.websockets.connect') as connect:
            for video_id in ['short', 'https://youtu.be/abcdefghijk', 'abcdefghij;']:
                with self.assertRaises(ValueError):
                    await control('load', None, '', video_id)
            connect.assert_not_called()

class YouTubeSeekTests(unittest.IsolatedAsyncioTestCase):
    async def test_seek_passes_position_and_expected_video(self):
        page = {'url': 'https://www.youtube.com/tv#/',
                'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        socket = AsyncMock()
        evaluate = AsyncMock(return_value={'accepted': True})
        with patch('youtube_control.get_tab', return_value=page), \
             patch('youtube_control.websockets.connect', return_value=socket), \
             patch('youtube_control.evaluate', evaluate):
            await control('seek', None, '// script', position_ms=12000, expected_video_id='abcdefghijk')
        payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
        self.assertEqual(payload, {'action': 'seek', 'positionMs': 12000, 'expectedVideoId': 'abcdefghijk'})
