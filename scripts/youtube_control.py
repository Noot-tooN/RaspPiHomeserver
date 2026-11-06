"""Bounded, allowlisted native YouTube player controls over loopback CDP."""
import argparse
import asyncio
import json
import re
from pathlib import Path
import sys
from urllib.parse import urlsplit

import websockets
from youtube_receiver import CDP, get_tab
from youtube_pairing import evaluate, tv_page


async def control(action, volume, script, video_id=None, position_ms=None, expected_video_id=None, enabled=None, queue_id=None, title=None, before_id=None):
    tab = await asyncio.to_thread(get_tab)
    endpoint = urlsplit(tab.get('webSocketDebuggerUrl', ''))
    if (not tv_page(tab.get('url', '')) or endpoint.scheme != 'ws'
            or endpoint.hostname != '127.0.0.1' or endpoint.port != 9222):
        raise ValueError('Receiver unavailable')
    payload = {'action': action}
    if action in ('removequeue', 'playqueue', 'reorderqueue'):
        if not isinstance(queue_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', queue_id):
            raise ValueError('Invalid queue entry')
        payload['queueID'] = queue_id
    elif queue_id is not None:
        raise ValueError('Unexpected queue entry')
    if action == 'reorderqueue':
        if not isinstance(before_id, str) or (before_id and not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', before_id)) or before_id == queue_id:
            raise ValueError('Invalid queue destination')
        payload['beforeID'] = before_id
    elif before_id is not None:
        raise ValueError('Unexpected queue destination')
    if title is not None:
        if action != 'enqueue' or not isinstance(title, str) or len(title) > 300:
            raise ValueError('Unexpected queue title')
        payload['title'] = title
    if action == 'autoplay':
        if type(enabled) is not bool:
            raise ValueError('Autoplay requires a boolean')
        payload['enabled'] = enabled
    elif enabled is not None:
        raise ValueError('Unexpected autoplay setting')
    if action == 'seek':
        if (type(position_ms) is not int or not 0 <= position_ms <= 604800000
                or not isinstance(expected_video_id, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{11}', expected_video_id)):
            raise ValueError('Invalid seek')
        payload.update(positionMs=position_ms, expectedVideoId=expected_video_id)
    elif position_ms is not None or expected_video_id is not None:
        raise ValueError('Unexpected seek parameters')
    if video_id is not None:
        if action not in ('load', 'enqueue') or not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError('Invalid video ID')
        payload['videoId'] = video_id
    if volume is not None:
        payload['volume'] = volume
    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=1024 * 1024) as socket:
        return await evaluate(CDP(socket), script + '\ncontrolYouTube(' + json.dumps(payload) + ')')


async def main(args):
    async with asyncio.timeout(3):
        script = Path(args.queue_script).read_text() + '\n' if args.queue_script else ''
        script += Path(args.script).read_text()
        return await control(args.action, args.volume, script, args.video_id, args.position_ms, args.expected_video_id, None if args.enabled is None else args.enabled == 'true', args.queue_id, args.title, args.before_id)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--script', required=True)
    parser.add_argument('--queue-script')
    parser.add_argument('--queue-id')
    parser.add_argument('--before-id')
    parser.add_argument('--title')
    parser.add_argument('--enabled', choices=['true', 'false'])
    parser.add_argument('action', choices=['state', 'volume', 'play', 'pause', 'previous', 'next', 'load', 'seek', 'mute', 'unmute', 'enqueue', 'autoplay', 'clearqueue', 'removequeue', 'playqueue', 'reorderqueue'])
    parser.add_argument('volume', type=int, nargs='?')
    parser.add_argument('--video-id')
    parser.add_argument('--position-ms', type=int)
    parser.add_argument('--expected-video-id')
    args = parser.parse_args()
    if (args.action == 'volume') != (args.volume is not None) or (args.volume is not None and not 0 <= args.volume <= 100):
        parser.error('Volume requires an integer from 0 to 100')
    if (args.action in ('load', 'enqueue')) != (args.video_id is not None) or (args.video_id is not None and not re.fullmatch(r'[A-Za-z0-9_-]{11}', args.video_id)):
        parser.error('Load requires a valid YouTube video ID')
    if (args.action == 'autoplay') != (args.enabled is not None):
        parser.error('Autoplay requires --enabled=true or false')
    try:
        print(json.dumps(asyncio.run(main(args))))
    except Exception:
        print('YouTube player unavailable', file=sys.stderr)
        sys.exit(1)
