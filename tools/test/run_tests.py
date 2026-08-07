"""Roda o harness de testes em um Chrome headless.

Sobe um servidor HTTP local (para que as URLs sejam http:// e o fetch funcione de verdade),
abre tools/test/harness.html no Chrome headless e aguarda o POST com o resultado.

Execute:  python tools/test/run_tests.py
"""

import http.server
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

CHROME_CANDIDATES = [
    os.path.join(os.environ.get("ProgramFiles", ""), "Google/Chrome/Application/chrome.exe"),
    os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Google/Chrome/Application/chrome.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google/Chrome/Application/chrome.exe"),
    os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft/Edge/Application/msedge.exe"),
    os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft/Edge/Application/msedge.exe"),
]

result_holder = {}
done = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        result_holder["body"] = self.rfile.read(length).decode("utf-8", "replace")
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *_args):
        pass


def find_browser():
    for candidate in CHROME_CANDIDATES:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def main():
    browser = find_browser()
    if not browser:
        print("Chrome/Edge nao encontrado; pulando os testes de navegador.")
        return 0

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as httpd:
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        url = f"http://127.0.0.1:{port}/tools/test/harness.html"
        profile = tempfile.mkdtemp(prefix="wcloner-test-")
        proc = subprocess.Popen(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                f"--user-data-dir={profile}",
                url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        got = done.wait(timeout=90)
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()

    if not got:
        print("TIMEOUT: o harness nao devolveu resultados em 90s.")
        return 1

    body = result_holder.get("body", "")
    print(body)
    time.sleep(0.1)
    return 1 if "FAIL" in body else 0


if __name__ == "__main__":
    sys.exit(main())
