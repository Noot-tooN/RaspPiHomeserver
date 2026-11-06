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

class YouTubeQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_enqueue_and_autoplay_are_bounded_json_commands(self):
        page = {'url': 'https://www.youtube.com/tv',
                'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        evaluate = AsyncMock(return_value={'accepted': True})
        with patch('youtube_control.get_tab', return_value=page), \
             patch('youtube_control.websockets.connect', return_value=AsyncMock()), \
             patch('youtube_control.evaluate', evaluate):
            await control('enqueue', None, '// script', video_id='abcdefghijk')
            payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
            self.assertEqual(payload, {'action': 'enqueue', 'videoId': 'abcdefghijk'})
            await control('autoplay', None, '// script', enabled=False)
            payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
            self.assertEqual(payload, {'action': 'autoplay', 'enabled': False})
            for enabled in [None, 'true', 1]:
                with self.assertRaises(ValueError):
                    await control('autoplay', None, '', enabled=enabled)


class YouTubeQueueEntryTests(unittest.IsolatedAsyncioTestCase):
    async def test_entry_ids_and_titles_are_validated_and_sent_as_json(self):
        page = {'url': 'https://www.youtube.com/tv',
                'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        evaluate = AsyncMock(return_value={'accepted': True})
        with patch('youtube_control.get_tab', return_value=page), \
             patch('youtube_control.websockets.connect', return_value=AsyncMock()), \
             patch('youtube_control.evaluate', evaluate):
            entry_id = '00000000-0000-4000-8000-000000000001'
            await control('removequeue', None, '// script', queue_id=entry_id)
            payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
            self.assertEqual(payload, {'action': 'removequeue', 'queueID': entry_id})
            await control('playqueue', None, '// script', queue_id=entry_id)
            payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
            self.assertEqual(payload, {'action': 'playqueue', 'queueID': entry_id})
            await control('enqueue', None, '// script', video_id='abcdefghijk', title='A "quoted" title')
            payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
            self.assertEqual(payload['title'], 'A "quoted" title')
            for entry in [None, 'invalid', '00000000; echo secret']:
                with self.assertRaises(ValueError):
                    await control('removequeue', None, '', queue_id=entry)
                with self.assertRaises(ValueError):
                    await control('playqueue', None, '', queue_id=entry)


class YouTubeQueueReorderTests(unittest.IsolatedAsyncioTestCase):
    async def test_reordering_validates_and_passes_stable_ids(self):
        page = {'url': 'https://www.youtube.com/tv', 'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/devtools/page/receiver'}
        evaluate = AsyncMock(return_value={'accepted': True})
        entry = '00000000-0000-4000-8000-000000000001'
        destination = '00000000-0000-4000-8000-000000000002'
        with patch('youtube_control.get_tab', return_value=page), patch('youtube_control.websockets.connect', return_value=AsyncMock()), patch('youtube_control.evaluate', evaluate):
            for before in [destination, '']:
                await control('reorderqueue', None, '// script', queue_id=entry, before_id=before)
                payload = json.loads(evaluate.call_args.args[1].split('\ncontrolYouTube(', 1)[1][:-1])
                self.assertEqual(payload, {'action': 'reorderqueue', 'queueID': entry, 'beforeID': before})
            calls = evaluate.call_count
            for before in [None, entry, 'invalid', 42]:
                with self.assertRaises(ValueError):
                    await control('reorderqueue', None, '', queue_id=entry, before_id=before)
            with self.assertRaises(ValueError):
                await control('playqueue', None, '', queue_id=entry, before_id=destination)
            self.assertEqual(evaluate.call_count, calls)
