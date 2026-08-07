"""Verificacao rapida de sanidade dos arquivos da extensao.

- valida o JSON do manifest
- confere se todos os arquivos declarados existem
- checa o balanceamento de chaves/parenteses dos scripts (fora de strings e comentarios)

Execute:  python tools/check_syntax.py
"""

import json
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRIPTS = ["background.js", "content.js", "popup.js", "offscreen.js"]
REQUIRED = SCRIPTS + [
    "manifest.json",
    "popup.html",
    "popup.css",
    "offscreen.html",
    "libs/jszip.min.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]


def strip_code(src):
    """Remove strings, templates, comentarios e regex literais, preservando os delimitadores."""
    out = []
    i, n = 0, len(src)
    prev_significant = ""
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if c == "/" and nxt == "/":
            i = src.find("\n", i)
            if i == -1:
                break
            continue
        if c == "/" and nxt == "*":
            end = src.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if c in "\"'`":
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
            i += 1
            prev_significant = "x"
            continue
        if c == "/" and prev_significant in ("", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+"):
            i += 1
            in_class = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    in_class = True
                elif src[i] == "]":
                    in_class = False
                elif src[i] == "/" and not in_class:
                    break
                elif src[i] == "\n":
                    break
                i += 1
            i += 1
            while i < n and src[i].isalpha():
                i += 1
            prev_significant = "x"
            continue

        out.append(c)
        if not c.isspace():
            prev_significant = c
        i += 1
    return "".join(out)


def check_balance(path):
    with open(path, "r", encoding="utf-8") as fh:
        code = strip_code(fh.read())

    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    line = 1
    for ch in code:
        if ch == "\n":
            line += 1
        elif ch in "([{":
            stack.append((ch, line))
        elif ch in ")]}":
            if not stack or stack[-1][0] != pairs[ch]:
                return f"desbalanceado: '{ch}' inesperado na linha {line}"
            stack.pop()
    if stack:
        return f"desbalanceado: '{stack[-1][0]}' aberto na linha {stack[-1][1]} sem fechamento"
    return None


def main():
    errors = []

    for rel in REQUIRED:
        if not os.path.exists(os.path.join(ROOT, rel)):
            errors.append(f"arquivo ausente: {rel}")

    manifest_path = os.path.join(ROOT, "manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
            print(f"manifest.json OK  (v{manifest['version']}, MV{manifest['manifest_version']})")
            for rel in [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]:
                if not os.path.exists(os.path.join(ROOT, rel)):
                    errors.append(f"referenciado no manifest mas ausente: {rel}")
            for rel in manifest["icons"].values():
                if not os.path.exists(os.path.join(ROOT, rel)):
                    errors.append(f"icone ausente: {rel}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"manifest.json invalido: {exc}")

    for script in SCRIPTS:
        path = os.path.join(ROOT, script)
        if not os.path.exists(path):
            continue
        problem = check_balance(path)
        print(f"{script:16s} {'OK' if problem is None else problem}")
        if problem:
            errors.append(f"{script}: {problem}")

    if errors:
        print("\nFALHAS:")
        for err in errors:
            print("  -", err)
        sys.exit(1)

    print("\nTudo certo.")


if __name__ == "__main__":
    main()
