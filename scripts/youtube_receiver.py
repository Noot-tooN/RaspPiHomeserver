"""Launch the receiver only after installing its page-start name override."""

import argparse
import asyncio
import json
import signal
import sys
import urllib.request
from pathlib import Path

import websockets
from service_status import publish

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


class CDPTimeout(TimeoutError):
    """A fixed command name is safe to log; page data and responses aren't."""


class CDP:
    """Drain unsolicited events while matching responses to our command IDs."""

    def __init__(self, socket, timeout=15):
        self.socket = socket
        self.sequence = 0
        self.timeout = timeout

    async def call(self, method, params=None):
        self.sequence += 1
        request_id = self.sequence
        try:
            async with asyncio.timeout(self.timeout):
                await self.socket.send(json.dumps({
                    "id": request_id, "method": method, "params": params or {},
                }))
                while True:
                    message = json.loads(await self.socket.recv())
                    if message.get("id") != request_id:
                        continue
                    if "error" in message:
                        # Avoid logging server responses that could contain account data.
                        raise RuntimeError(f"Browser command failed: {method}")
                    return message.get("result", {})
        except TimeoutError as error:
            raise CDPTimeout(f"Browser command timed out: {method}") from error


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


async def initialize_receiver(cdp, name_script, queue_script=None):
    await cdp.call("Page.enable")
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": name_script})
    if queue_script:
        await cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": queue_script})
    # This order is essential: attach while blank, inject, THEN navigate.
    await cdp.call("Page.navigate", {"url": TV_URL})
    # No Page events are used by the monitor. Stop subscribing before its
    # 30-second sleeps so navigation events cannot fill the WebSocket queue.
    await cdp.call("Page.disable")


async def monitor_receiver(browser, cdp, target_id, process):
    failures = 0
    while True:
        await asyncio.sleep(30)
        if process.returncode is not None:
            raise RuntimeError("Browser exited")
        try:
            await close_other_pages(browser, target_id)
            result = await cdp.call("Runtime.evaluate", {
                "expression": HEALTH_EXPRESSION, "returnByValue": True,
            })
            state = json.loads(result.get("result", {}).get("value", "{}"))
            reason = health_failure(state)
        except CDPTimeout:
            # A busy Pi can miss one command deadline during startup/updates.
            # Count it like any other failed check instead of killing the page
            # immediately and forcing another expensive browser startup.
            reason = "browser-command-timeout"
        if reason is None:
            if failures:
                print("YouTube receiver: health check recovered", file=sys.stderr, flush=True)
            failures = 0
            publish("healthy", "healthy")
        else:
            failures += 1
            publish("unhealthy", reason, failures)
            print(f"YouTube receiver: health check {failures}/3: {reason}",
                  file=sys.stderr, flush=True)
        if failures >= 3:
            raise RuntimeError("YouTube page failed three consecutive health checks")


async def supervise(args):
    publish("starting", "browser_starting")
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
            publish("starting", "page_loading")
            # Cold browser startup after an update is slower than steady-state
            # commands on this 2 GB Pi. Keep it bounded, with a separate budget.
            browser = CDP(browser_socket, timeout=60)
            target_id = await create_receiver_page(browser)
            tab = await asyncio.to_thread(get_tab, target_id)
            async with websockets.connect(
                tab["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024, max_queue=256,
            ) as socket:
                cdp = CDP(socket, timeout=60)
                await initialize_receiver(cdp, Path(args.name_script).read_text(), Path(args.queue_script).read_text() if args.queue_script else None)
                browser.timeout = cdp.timeout = 15
                publish("starting", "page_loading")
                await monitor_receiver(browser, cdp, target_id, process)
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
    parser.add_argument("--queue-script")
    parser.add_argument("--profile", required=True)
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments))
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    except Exception as error:
        if isinstance(error, CDPTimeout):
            code = "browser-command-timeout"
        elif str(error) == "YouTube page failed three consecutive health checks":
            code = "health_checks_failed"
        elif str(error) == "Browser debugging endpoint did not become ready":
            code = "browser_endpoint_timeout"
        elif str(error) in ("Browser exited", "Browser exited during startup"):
            code = "browser_exited"
        else:
            code = "receiver_failed"
        publish("failed", code)
        # Known errors are fixed messages; unexpected exceptions log only their type.
        message = str(error) if isinstance(error, (RuntimeError, CDPTimeout)) else type(error).__name__
        print(f"YouTube receiver: {message}", file=sys.stderr)
        sys.exit(1)
