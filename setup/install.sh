#!/usr/bin/env bash
set -euo pipefail

WT_DIR="/opt/watch-together"
WT_REPO="$WT_DIR/repo"
WT_PORT="${WT_PORT:-8765}"
WT_USER="${WT_USER:-${SUDO_USER:-$USER}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<HELP
Uso: sudo bash setup/install.sh

Variabili:
  WT_DOMAIN     Dominio (es. wt.example.com)
  WT_PORT       Porta relay (default: 8765)
  WT_USER       Utente systemd (default: SUDO_USER)
  NGINX_SITE    File nginx (autodetect)
  WT_ADMIN_USER Username admin (default: admin)
  WT_ADMIN_PASS Password admin (vuota = login off)

Esempi:
  sudo bash setup/install.sh
  sudo WT_DOMAIN=wt.example.com WT_ADMIN_PASS=segreta bash setup/install.sh
HELP
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERRORE: esegui con sudo." >&2
  exit 1
fi

WT_SRC="$REPO_ROOT/server/wt_server.py"
HP_SRC="$REPO_ROOT/server/homepage.html"
JS_SRC="$REPO_ROOT/userscript/watch-together.user.js"
for f in "$WT_SRC" "$HP_SRC" "$JS_SRC"; do
  if [ ! -f "$f" ]; then
    echo "ERRORE: non trovo $f" >&2
    exit 1
  fi
done

DOMAIN="${WT_DOMAIN:-}"
[ -z "$DOMAIN" ] && read -rp "Il tuo dominio (es. wt.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "ERRORE: dominio obbligatorio." >&2
  exit 1
fi

ADMIN_USER="${WT_ADMIN_USER:-admin}"
ADMIN_PASS="${WT_ADMIN_PASS:-}"
if [ -z "$ADMIN_PASS" ]; then
  read -rsp "Password admin (lascia vuoto per disabilitare il login): " ADMIN_PASS
  echo
fi

NGINX_SITE="${NGINX_SITE:-}"
if [ -z "$NGINX_SITE" ] && [ -d /etc/nginx/sites-enabled ]; then
  NGINX_SITE=$(grep -rl "server_name.*$DOMAIN" /etc/nginx/sites-enabled/ 2>/dev/null | head -1 || true)
fi
if [ -z "$NGINX_SITE" ] && [ -d /etc/nginx/conf.d ]; then
  NGINX_SITE=$(grep -rl "server_name.*$DOMAIN" /etc/nginx/conf.d/ 2>/dev/null | head -1 || true)
fi
if [ -z "$NGINX_SITE" ] || [ ! -f "$NGINX_SITE" ]; then
  echo "Non trovo un file nginx con 'server_name $DOMAIN'."
  read -rp "Percorso del file nginx: " NGINX_SITE
fi
[ ! -f "$NGINX_SITE" ] && { echo "ERRORE: $NGINX_SITE non esiste." >&2; exit 1; }

echo
echo "Configurazione:"
echo "  Dominio      : $DOMAIN"
echo "  Porta relay  : $WT_PORT"
echo "  Utente       : $WT_USER"
echo "  Directory    : $WT_DIR"
echo "  File nginx   : $NGINX_SITE"
echo "  Admin user   : $ADMIN_USER"
if [ -n "$ADMIN_PASS" ]; then
  echo "  Admin pass   : (impostata)"
else
  echo "  Admin pass   : (LOGIN DISABILITATO)"
fi
echo
read -rp "Procedo? [s/N] " _confirm
case "${_confirm,,}" in
  s|si|y|yes) ;;
  *) echo "Annullato."; exit 0 ;;
esac

echo "==> [1/7] Dipendenze di sistema"
if   command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq python3 python3-pip python3-venv nginx curl
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q python3 python3-pip nginx curl
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q python3 python3-pip nginx curl
else
  echo "!! Gestore pacchetti non riconosciuto." >&2
fi

echo "==> [2/7] Copio sorgenti in $WT_REPO"
mkdir -p "$WT_REPO/userscript" "$WT_DIR"
cp -f "$WT_SRC" "$WT_DIR/wt_server.py"
cp -f "$HP_SRC" "$WT_DIR/homepage.html"
cp -f "$JS_SRC" "$WT_REPO/userscript/watch-together.user.js"
chown -R "$WT_USER:$WT_USER" "$WT_DIR"
mkdir -p /var/www/html
cp -f "$HP_SRC" /var/www/html/watch.html
chmod 644 /var/www/html/watch.html

echo "==> [3/7] Creo venv dedicato"
if [ ! -d "$WT_DIR/venv" ]; then
  python3 -m venv "$WT_DIR/venv"
fi
"$WT_DIR/venv/bin/pip" install --quiet --upgrade pip
"$WT_DIR/venv/bin/pip" install --quiet websockets

if ! "$WT_DIR/venv/bin/python" -c "import websockets" 2>/dev/null; then
  echo "ERRORE: websockets non installato." >&2
  exit 1
fi

echo "==> [4/7] Scrivo credenziali admin in $WT_DIR/.admin_env"
if [ -n "$ADMIN_PASS" ]; then
  cat > "$WT_DIR/.admin_env" <<ENVEOF
WT_ADMIN_USER=$ADMIN_USER
WT_ADMIN_PASS=$ADMIN_PASS
ENVEOF
  chmod 600 "$WT_DIR/.admin_env"
  chown "$WT_USER:$WT_USER" "$WT_DIR/.admin_env"
  echo "    file creato"
else
  rm -f "$WT_DIR/.admin_env"
  echo "    (nessuna password: login admin disabilitato)"
fi

echo "==> [5/7] Servizio systemd"
cat > /etc/systemd/system/watch-together.service <<SVCEOF
[Unit]
Description=Watch Together WebSocket Relay
After=network.target

[Service]
Type=simple
User=$WT_USER
Group=$WT_USER
WorkingDirectory=$WT_DIR
Environment=WT_HOST=127.0.0.1
Environment=WT_PORT=$WT_PORT
EnvironmentFile=-$WT_DIR/.admin_env
ExecStart=$WT_DIR/venv/bin/python $WT_DIR/wt_server.py
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now watch-together.service
systemctl restart watch-together.service
sleep 1
if ! systemctl is-active --quiet watch-together; then
  echo "!! Servizio non attivo. Log:" >&2
  journalctl -u watch-together -n 20 --no-pager >&2 || true
  exit 1
fi

echo "==> [6/7] Blocco Nginx in $NGINX_SITE"
BACKUP="${NGINX_SITE}.backup.$(date +%s)"
cp -n "$NGINX_SITE" "$BACKUP" 2>/dev/null || true

python3 - "$NGINX_SITE" "$WT_PORT" "$WT_REPO" <<'PYEOF'
import re, sys, pathlib

path = pathlib.Path(sys.argv[1])
port = sys.argv[2]
repo = sys.argv[3]
txt = path.read_text()

MARK_BEGIN = "# === Watch Together (auto-generated) ==="
MARK_END   = "# === /Watch Together ==="
block = f"""
    {MARK_BEGIN}
    location /wt {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}

    location = /wt.user.js {{
        alias {repo}/userscript/watch-together.user.js;
        default_type application/javascript;
        sub_filter_types application/javascript text/plain;
        sub_filter 'YOUR_SERVER_HERE' $host;
        sub_filter_once off;
    }}
    {MARK_END}
"""

txt = re.sub(
    r"\n\s*" + re.escape(MARK_BEGIN) + r".*?" + re.escape(MARK_END) + r"\n",
    "\n", txt, flags=re.S,
)

def find_server_443(text):
    for m in re.finditer(r"server\s*\{", text):
        start = m.start()
        i = m.end() - 1
        depth = 0
        while i < len(text):
            c = text[i]
            if c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    if re.search(r"listen\s+443", text[start:i+1]):
                        return start, i+1
                    break
            i += 1
    return None

res = find_server_443(txt)
if not res:
    print("!! Nessun server block con 'listen 443'.", file=sys.stderr)
    print("!! Aggiungi manualmente questo blocco al tuo vhost HTTPS:", file=sys.stderr)
    print(block, file=sys.stderr)
    sys.exit(1)

start, end = res
sb = txt[start:end]
idx = sb.rfind("}")
new_sb = sb[:idx] + block + sb[idx:]
path.write_text(txt[:start] + new_sb + txt[end:])
print("Nginx aggiornato.")
PYEOF

echo "==> [7/7] Test e reload Nginx"
if ! nginx -t 2>&1; then
  echo
  echo "!! Config nginx non valida. Ripristino backup..." >&2
  [ -f "$BACKUP" ] && cp -f "$BACKUP" "$NGINX_SITE"
  echo "Nginx non ricaricato." >&2
  exit 1
fi
systemctl reload nginx

echo
echo "=========================================="
echo " INSTALLAZIONE COMPLETATA"
echo "=========================================="
echo " Homepage:   https://$DOMAIN/watch"
echo " Userscript: https://$DOMAIN/wt.user.js"
echo " WebSocket:  wss://$DOMAIN/wt"
echo " Servizio:   systemctl status watch-together"
echo " Log:        journalctl -u watch-together -f"
echo " DB stanze:  $WT_DIR/rooms.db"
[ -n "$ADMIN_PASS" ] && echo " Admin:      $ADMIN_USER / (password impostata)"
echo " Backup nginx: $BACKUP"
echo
echo " Test:"
echo "   curl -sI https://$DOMAIN/wt.user.js | head -1"
echo "   (atteso: 200 OK)"
echo "=========================================="
