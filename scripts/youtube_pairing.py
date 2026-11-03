"""Open the receiver's TV-code screen on request; emit only the numeric code."""

import asyncio
import json
import re
import sys
from urllib.parse import urlsplit

import websockets

from youtube_receiver import CDP, TV_URL, get_tab


def tv_page(url):
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.netloc == "www.youtube.com"
            and (parsed.path == "/tv" or parsed.path.startswith("/tv/")))


def extract_code(text):
    # Never return a Google account sign-in code or a number from a video title.
    if "Link with TV code" not in text:
        return None
    for line in text.splitlines():
        value = re.sub(r"[\s\u200e\u200f]", "", line)
        if re.fullmatch(r"[0-9]{12}", value):
            return value
    return None


async def evaluate(cdp, expression):
    result = await cdp.call("Runtime.evaluate", {
        "expression": expression, "returnByValue": True,
    })
    if "exceptionDetails" in result:
        raise RuntimeError("YouTube page could not be read")
    return result.get("result", {}).get("value")


async def press(cdp, key, code):
    for kind in ("keyDown", "keyUp"):
        await cdp.call("Input.dispatchKeyEvent", {
            "type": kind, "key": key, "code": key,
            "windowsVirtualKeyCode": code,
        })


async def activate(cdp, label):
    # Focus a known control and use the TV's keyboard handling. DOM click() does
    # not activate these custom elements. Never press Enter without a match.
    focused = await evaluate(cdp, """(() => {
      const label = %s;
      const element = [...document.querySelectorAll(
        '[role=button],[role=menuitem],[role=tab]'
      )].find(e => (e.innerText.trim() === label || e.getAttribute('aria-label') === label)
        && (label === 'Settings' || e.getAttribute('aria-hidden') !== 'true') && e.getClientRects().length);
      if (!element) return false;
      element.focus();
      return document.activeElement === element;
    })()""" % json.dumps(label))
    if focused:
        await press(cdp, "Enter", 13)
    return bool(focused)


async def select_tv_code(cdp):
    # Settings changes its right-hand pane on remote navigation, not focus().
    # Move into the sidebar, then navigate toward the known visible label.
    for _ in range(24):
        direction = await evaluate(cdp, """(() => {
          const active = document.activeElement;
          const label = e => e?.querySelector('yt-formatted-string')?.textContent.trim() || e?.innerText.trim();
          const sidebar = active?.closest('ytlr-tab-renderer');
          if (!sidebar) return label(active) === 'Settings' ? 'enter' : 'left';
          if (label(active) === 'Link with TV code') return 'selected';
          const target = [...document.querySelectorAll('ytlr-tab-renderer')]
            .find(e => label(e) === 'Link with TV code');
          if (!target || !active) return 'missing';
          return target.getBoundingClientRect().top < active.getBoundingClientRect().top ? 'up' : 'down';
        })()""")
        if direction == "selected":
            return
        keys = {"up": ("ArrowUp", 38), "down": ("ArrowDown", 40),
                "left": ("ArrowLeft", 37), "enter": ("Enter", 13)}
        if direction not in keys:
            raise RuntimeError("YouTube settings navigation changed")
        await press(cdp, *keys[direction])
        await asyncio.sleep(0.1)
    raise RuntimeError("YouTube TV-code setting was not found")


async def pair():
    tab = await asyncio.to_thread(get_tab)
    if not tv_page(tab.get("url", "")):
        raise RuntimeError("YouTube receiver is not ready")
    endpoint = urlsplit(tab["webSocketDebuggerUrl"])
    if endpoint.scheme != "ws" or endpoint.hostname != "127.0.0.1" or endpoint.port != 9222:
        raise RuntimeError("Unexpected browser endpoint")
    async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=2 * 1024 * 1024) as socket:
        cdp = CDP(socket)
        await cdp.call("Page.bringToFront")
        navigated = False
        opened_guide = False
        for _ in range(35):
            state = await evaluate(cdp, "({url:location.href,text:document.body?.innerText || ''})")
            if not state or not tv_page(state.get("url", "")):
                raise RuntimeError("YouTube receiver is not ready")
            code = extract_code(state["text"])
            if code:
                return {"code": code}
            if state["text"].startswith("Settings\n") and "Link with TV code" in state["text"]:
                await select_tv_code(cdp)
                await asyncio.sleep(0.5)
                continue
            # A new profile needs guest mode, not a Google account login.
            acted = False
            for label in ("Watch as guest", "Get started", "Settings"):
                if await activate(cdp, label):
                    acted = True
                    break
            if not acted and not navigated:
                # Leave a player/overlay before opening the guide. This is why
                # the UI warns that requesting a code can interrupt YouTube.
                await cdp.call("Page.navigate", {"url": TV_URL})
                navigated = True
            elif not acted and not opened_guide:
                await press(cdp, "ArrowLeft", 37)
                opened_guide = True
            await asyncio.sleep(0.5)
    raise RuntimeError("YouTube pairing screen is unavailable")


async def main():
    async with asyncio.timeout(25):
        return await pair()


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main())))
    except Exception:
        # Page contents, sign-in codes and CDP responses must never enter logs.
        print("YouTube pairing screen is unavailable", file=sys.stderr)
        sys.exit(1)
