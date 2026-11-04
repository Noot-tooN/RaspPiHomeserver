"""Bounded, allowlisted native YouTube player controls over loopback CDP."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

import websockets
from youtube_receiver import CDP, get_tab
from youtube_pairing import evaluate, tv_page


async def control(action, volume, script):
    tab = await asyncio.to_thread(get_tab)
    endpoint = urlsplit(tab.get('webSocketDebuggerUrl', ''))
    if (not tv_page(tab.get('url', '')) or endpoint.scheme != 'ws'
            or endpoint.hostname != '127.0.0.1' or endpoint.port != 9222):
        raise ValueError('Receiver unavailable')
    payload = {'action': action}
    if volume is not None:
        payload['volume'] = volume
    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=1024 * 1024) as socket:
        return await evaluate(CDP(socket), script + '\ncontrolYouTube(' + json.dumps(payload) + ')')


async def main(args):
    async with asyncio.timeout(3):
        return await control(args.action, args.volume, Path(args.script).read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--script', required=True)
    parser.add_argument('action', choices=['state', 'volume', 'play', 'pause', 'previous', 'next'])
    parser.add_argument('volume', type=int, nargs='?')
    args = parser.parse_args()
    if (args.action == 'volume') != (args.volume is not None) or (args.volume is not None and not 0 <= args.volume <= 100):
        parser.error('Volume requires an integer from 0 to 100')
    try:
        print(json.dumps(asyncio.run(main(args))))
    except Exception:
        print('YouTube player unavailable', file=sys.stderr)
        sys.exit(1)
