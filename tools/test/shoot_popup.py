"""Gera screenshots do popup em cada estado (idle, running, done, error, blocked).

Execute:  python tools/test/shoot_popup.py
Saida:    tools/test/shots/popup-<estado>.png
"""

import http.server
import os
import socketserver
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SHOTS = os.path.join(ROOT, "tools", "test", "shots")

STATES = {
    "idle": 470,
    "running": 620,
    "done": 760,
    "error": 560,
    "blocked": 560,
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, *_args):
        pass


def find_browser():
    for candidate in [
        os.path.join(os.environ.get("ProgramFiles", ""), "Google/Chrome/Application/chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft/Edge/Application/msedge.exe"),
    ]:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def main():
    browser = find_browser()
    if not browser:
        print("Navegador nao encontrado.")
        return 1

    os.makedirs(SHOTS, exist_ok=True)

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        for state, height in STATES.items():
            out = os.path.join(SHOTS, f"popup-{state}.png")
            url = f"http://127.0.0.1:{port}/tools/test/popup-preview.html?state={state}"
            profile = tempfile.mkdtemp(prefix=f"wcloner-shot-{state}-")
            subprocess.run(
                [
                    browser,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    "--hide-scrollbars",
                    "--force-device-scale-factor=2",
                    f"--window-size=384,{height}",
                    "--virtual-time-budget=4000",
                    f"--user-data-dir={profile}",
                    f"--screenshot={out}",
                    url,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=90,
            )
            print(("ok   " if os.path.exists(out) else "FALHA") + f"  {out}")

        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
