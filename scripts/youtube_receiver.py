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
  label: window.environment?.feature_switches?.mdx_device_label
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


def page_healthy(state):
    # An account chooser is healthy; an empty document or browser error is not.
    return (
        state.get("host") == "www.youtube.com"
        and state.get("ready") in ("interactive", "complete")
        and state.get("textLength", 0) > 0
        and state.get("label") == "RaspPi"
    )


def get_tab():
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=2) as response:
        tabs = json.load(response)
    tab = next((tab for tab in tabs if tab.get("type") == "page"), None)
    if tab is None:
        raise ValueError("No browser page yet")
    return tab


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
                tab = await asyncio.to_thread(get_tab)
                break
            except (OSError, ValueError):
                await asyncio.sleep(1)
        else:
            raise RuntimeError("Browser debugging endpoint did not become ready")

        async with websockets.connect(
            tab["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024, max_queue=256,
        ) as socket:
            cdp = CDP(socket)
            await cdp.call("Page.enable")
            await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
                "source": Path(args.name_script).read_text(),
            })
            # This order is essential: attach while blank, inject, THEN navigate.
            await cdp.call("Page.navigate", {"url": TV_URL})
            failures = 0
            while True:
                await asyncio.sleep(30)
                if process.returncode is not None:
                    raise RuntimeError("Browser exited")
                result = await cdp.call("Runtime.evaluate", {
                    "expression": HEALTH_EXPRESSION, "returnByValue": True,
                })
                state = json.loads(result.get("result", {}).get("value", "{}"))
                failures = 0 if page_healthy(state) else failures + 1
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
