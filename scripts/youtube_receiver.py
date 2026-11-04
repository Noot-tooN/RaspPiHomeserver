"""Launch the receiver only after installing its page-start name override."""

import argparse
import asyncio
import json
import signal
import sys
import urllib.request
from pathlib import Path

import websockets

TV_URL = "https://www.youtube.com/tv"
USER_AGENT = (
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) SamsungBrowser/4.0 TV Safari/537.36"
)
HEALTH_EXPRESSION = """JSON.stringify({
  host: location.hostname,
  ready: document.readyState,
  textLength: document.body?.innerText.trim().length || 0,
  mediaReady: [...document.querySelectorAll('video')].some(video =>
    !!video.currentSrc && video.readyState >= 1 && !video.error)
})"""


class CDP:
    """Drain unsolicited events while matching responses to our command IDs."""

    def __init__(self, socket):
        self.socket = socket
        self.sequence = 0

    async def call(self, method, params=None):
        self.sequence += 1
        request_id = self.sequence
        await self.socket.send(json.dumps({
            "id": request_id, "method": method, "params": params or {},
        }))
        async with asyncio.timeout(15):
            while True:
                message = json.loads(await self.socket.recv())
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    # Avoid logging server responses that could contain account data.
                    raise RuntimeError(f"Browser command failed: {method}")
                return message.get("result", {})


def health_failure(state):
    if state.get("host") != "www.youtube.com":
        return "unexpected-host"
    if state.get("ready") not in ("interactive", "complete"):
        return "document-loading"
    # YouTube hides its text overlay during playback. Loaded media is healthy
    # even when paused or buffering; visibility and time advancement are not
    # liveness signals. Branding is also independent of browser health.
    if state.get("textLength", 0) <= 0 and state.get("mediaReady") is not True:
        return "empty-page-without-loaded-media"
    return None


def page_healthy(state):
    return health_failure(state) is None


def get_tab(target_id=None):
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=2) as response:
        tabs = json.load(response)
    pages = [tab for tab in tabs if tab.get("type") == "page"
             and (target_id is None or tab.get("id") == target_id)]
    if len(pages) != 1:
        # Pairing and playback helpers must never control an arbitrary restored tab.
        raise ValueError("Expected exactly one receiver page")
    return pages[0]


def get_browser_url():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2) as response:
        return json.load(response)["webSocketDebuggerUrl"]


async def close_other_pages(browser, target_id):
    targets = (await browser.call("Target.getTargets"))["targetInfos"]
    if not any(target["targetId"] == target_id for target in targets):
        raise RuntimeError("Receiver page disappeared")
    for target in targets:
        if target.get("type") == "page" and target["targetId"] != target_id:
            await browser.call("Target.closeTarget", {"targetId": target["targetId"]})


async def create_receiver_page(browser):
    # This profile belongs exclusively to the receiver. Brave can restore old
    # YouTube tabs; none has our document-start injection attached. Keep profile
    # storage (including pairing) but replace its pages with one blank target.
    target_id = (await browser.call("Target.createTarget", {"url": "about:blank"}))["targetId"]
    await close_other_pages(browser, target_id)
    return target_id


async def initialize_receiver(cdp, name_script):
    await cdp.call("Page.enable")
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": name_script})
    # This order is essential: attach while blank, inject, THEN navigate.
    await cdp.call("Page.navigate", {"url": TV_URL})


async def supervise(args):
    process = await asyncio.create_subprocess_exec(
        args.browser,
        f"--user-data-dir={args.profile}",
        "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
        "--password-store=basic", "--autoplay-policy=no-user-gesture-required",
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
        f"--user-agent={USER_AGENT}", "--kiosk", "about:blank",
        stdout=asyncio.subprocess.DEVNULL,
    )
    try:
        for _ in range(60):
            if process.returncode is not None:
                raise RuntimeError("Browser exited during startup")
            try:
                browser_url = await asyncio.to_thread(get_browser_url)
                break
            except (OSError, ValueError):
                await asyncio.sleep(1)
        else:
            raise RuntimeError("Browser debugging endpoint did not become ready")

        async with websockets.connect(browser_url) as browser_socket:
            browser = CDP(browser_socket)
            target_id = await create_receiver_page(browser)
            tab = await asyncio.to_thread(get_tab, target_id)
            async with websockets.connect(
                tab["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024, max_queue=256,
            ) as socket:
                cdp = CDP(socket)
                await initialize_receiver(cdp, Path(args.name_script).read_text())
                failures = 0
                while True:
                    await asyncio.sleep(30)
                    if process.returncode is not None:
                        raise RuntimeError("Browser exited")
                    # Also remove pages restored late or opened by the TV UI.
                    await close_other_pages(browser, target_id)
                    result = await cdp.call("Runtime.evaluate", {
                        "expression": HEALTH_EXPRESSION, "returnByValue": True,
                    })
                    state = json.loads(result.get("result", {}).get("value", "{}"))
                    reason = health_failure(state)
                    if reason is None:
                        if failures:
                            print("YouTube receiver: health check recovered", file=sys.stderr, flush=True)
                        failures = 0
                    else:
                        failures += 1
                        # Fixed categories only: never log page text, media URLs,
                        # video titles, account details, or pairing codes.
                        print(f"YouTube receiver: health check {failures}/3: {reason}",
                              file=sys.stderr, flush=True)
                    if failures >= 3:
                        raise RuntimeError("YouTube page failed three consecutive health checks")
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


async def main(args):
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    await supervise(args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--name-script", required=True)
    parser.add_argument("--profile", required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments))
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    except Exception as error:
        # Known errors are fixed messages; unexpected exceptions log only their type.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"YouTube receiver: {message}", file=sys.stderr)
        sys.exit(1)
