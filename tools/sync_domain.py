#!/usr/bin/env python3
"""
Aggiorna dinamicamente il dominio di StreamingCommunity nel file userscript
leggendo l'ultimo messaggio dal canale Telegram pubblico.
"""
import pathlib
import re
import sys
import urllib.request

CHANNEL_NAME = "streaming_community"
USERSCRIPT   = pathlib.Path(__file__).parent.parent / "userscript" / "watch-together.user.js"

BLACKLIST = (
    "t.me", "telegram", "twitter.com", "facebook.com", "youtube.com",
    "google.com", "github.com", "wikipedia.org",
)

DOMAIN_RE = re.compile(
    r"(?:https?://)?"
    r"([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)",
    re.IGNORECASE,
)


def fetch_last_message() -> str | None:
    url = f"https://t.me/s/{CHANNEL_NAME}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
    except Exception as e:
        print(f"[!] Download fallito: {e}", file=sys.stderr)
        return None

    blocks = re.findall(
        r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>',
        html, re.DOTALL,
    )
    if not blocks:
        print("[!] Nessun blocco messaggio trovato.", file=sys.stderr)
        return None

    last = blocks[-1]
    text = re.sub(r"<br\s*/?>", "\n", last)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return text.strip()


def extract_domain(text: str) -> str | None:
    if not text:
        return None
    candidates = []
    for match in DOMAIN_RE.finditer(text):
        dom = match.group(1).lower()
        if any(b in dom for b in BLACKLIST):
            continue
        if "streaming" in dom or "community" in dom:
            candidates.append(dom)
    if not candidates:
        return None
    return max(candidates, key=len)


def update_userscript(domain: str) -> bool:
    if not USERSCRIPT.exists():
        print(f"[!] Non trovo {USERSCRIPT}", file=sys.stderr)
        return False

    content = USERSCRIPT.read_text(encoding="utf-8")
    old_re = re.compile(r"// @match\s+https://streamingcommunity[^\s]*")
    new_line = f"// @match        https://{domain}/*"

    if old_re.search(content):
        new_content = old_re.sub(new_line, content)
    else:
        marker = "// @match        https://*.vixcloud.co/*"
        if marker in content:
            new_content = content.replace(marker, marker + "\n" + new_line)
        else:
            print("[!] Nessun punto d'inserimento trovato.", file=sys.stderr)
            return False

    if new_content == content:
        print(f"[=] Nessuna modifica: il dominio è già {domain}")
        return False

    USERSCRIPT.write_text(new_content, encoding="utf-8")
    return True


def main() -> int:
    print(f"[*] Leggo @{CHANNEL_NAME}…")
    text = fetch_last_message()
    if not text:
        return 1

    print(f"[*] Ultimo messaggio: {text[:150]!r}…")
    domain = extract_domain(text)
    if not domain:
        print("[!] Nessun dominio riconosciuto.", file=sys.stderr)
        return 1

    print(f"[+] Dominio trovato: {domain}")
    if update_userscript(domain):
        print(f"[✓] Userscript aggiornato: https://{domain}/*")
    return 0


if __name__ == "__main__":
    sys.exit(main())
