# Guida all'installazione

## Indice

- Parte 1 - Server
- Parte 2 - Homepage e pannello admin
- Parte 3 - Client desktop (Tampermonkey)
- Parte 4 - Client iOS (Userscripts)
- Parte 5 - Uso quotidiano
- Parte 6 - Problemi comuni

---

## Parte 1 - Server

### 1.1 Prerequisiti

- VPS Linux (Ubuntu 22.04+ / Debian 12+ / Fedora 39+)
- Dominio o sottodominio che punta all'IP del server
- Certificato TLS attivo (Let's Encrypt)
- Accesso sudo

Se non hai ancora il certificato:

    sudo apt install certbot python3-certbot-nginx
    sudo certbot --nginx -d wt.example.com

### 1.2 Clona e installa

    git clone https://github.com/cosimomandrillo/WatchTogheterOnOCI-.git
    cd WatchTogheterOnOCI-
    sudo bash setup/install.sh

Lo script chiede:

- Dominio (es. wt.example.com)
- Password admin (per il pannello di gestione; lascia vuoto per disabilitare il login)

E installa automaticamente:

- Python + venv in /opt/watch-together/venv
- wt_server.py e homepage.html in /opt/watch-together/
- Lo userscript in /opt/watch-together/repo/userscript/
- Il servizio systemd watch-together.service (con EnvironmentFile per le credenziali admin)
- Un blocco Nginx con due location:
  - /wt       -> proxy WebSocket verso 127.0.0.1:8765
  - /wt.user.js -> serve lo userscript iniettando il tuo dominio al posto di YOUR_SERVER_HERE

### 1.3 Verifica

    systemctl status watch-together --no-pager

Deve dire active (running).

    sudo nginx -T | grep -A6 "location /wt"

Deve mostrare i due blocchi proxy/alias.

    curl -sI https://wt.example.com/wt.user.js | head -1

Deve restituire HTTP/2 200.

---

## Parte 2 - Homepage e pannello admin

Apri https://wt.example.com/watch

### 2.1 Cosa vedi

- Lista delle stanze attive con titolo del film/episodio, numero di utenti connessi e avatar colorato (o immagine del poster)
- Filtri Tutte / Live / Permanenti e barra di ricerca
- FAB "Nuova stanza" in basso a destra
- Icona chiave in alto a destra per accedere al pannello admin

### 2.2 Accesso admin

1. Clicca l'icona chiave
2. Inserisci username (admin di default) e la password scelta
3. La barra dorata "Modalita amministratore" appare in alto
4. Su ogni stanza compaiono i pulsanti modifica ed elimina

### 2.3 Modifica stanza

Da modifica puoi cambiare:

- URL del video (verra aggiornato automaticamente quando cambi episodio)
- URL immagine (avatar) - incolla un URL di un poster
- Password - lascia vuoto per non cambiarla
- Stanza permanente - non viene cancellata quando tutti escono

### 2.4 Reset password admin

Se dimentichi la password:

    ssh tuo-utente@server
    sudo nano /opt/watch-together/.admin_env
    # cambia WT_ADMIN_PASS
    sudo systemctl restart watch-together

---

## Parte 3 - Client desktop (Tampermonkey)

### 3.1 Installa Tampermonkey

- Chrome / Brave / Edge -> Chrome Web Store
- Firefox -> addons.mozilla.org

Importante - Chrome / Brave 138+:

1. chrome://extensions -> Dettagli su Tampermonkey
2. Attiva "Consenti script utente"
3. Attiva "Modalita sviluppatore" in alto a destra
4. Aggiorna in alto a sinistra
5. Chiudi e riapri il browser

### 3.2 Installa lo userscript

Apri nel browser:

    https://wt.example.com/wt.user.js

Il dominio viene iniettato automaticamente da nginx. Tampermonkey chiede Reinstalla -> conferma.

### 3.3 Verifica la versione

Tampermonkey -> Dashboard -> Watch Together. Deve corrispondere alla versione piu recente.

### 3.4 Usa

1. Apri il player su StreamingCommunity
2. Il badge WT appare in alto a destra
3. Al primo utilizzo ti chiede stanza, password (se serve) e nome per la chat
4. Il badge diventa verde con il nome della stanza

---

## Parte 4 - Client iOS (Userscripts)

### 4.1 Installa Userscripts

1. App Store -> "Userscripts"
2. Impostazioni iOS -> Safari -> Estensioni -> Userscripts -> attiva
3. Tocca Userscripts -> Consenti su Tutti i siti web

### 4.2 Importa lo script

Apri https://wt.example.com/wt.user.js in Safari. L'app propone l'installazione -> conferma.

### 4.3 Usa

1. Apri il player su Safari
2. Il badge appare in alto a destra
3. Compila il form di join (nome + password)
4. Se l'autoplay e bloccato, tocca il badge quando dice "TAP per play"

---

## Parte 5 - Uso quotidiano

### Creare una stanza

1. Da /watch -> FAB "Nuova stanza" (richiede login admin per gestirla)
2. Da StreamingCommunity -> dal room picker che appare se non sei in nessuna stanza

### Unirsi a una stanza

Apri /watch, clicca la stanza -> modale con nome e password -> Entra.

Il link verra aperto sull'episodio corretto. Se l'owner ha gia iniziato, ti sincronizzi automaticamente.

### Auto-update dell'URL

Mentre guardi, ogni 5 secondi il client controlla se l'episodio e cambiato (/watch/61?e=1303 -> /watch/61?e=1304). Se si, aggiorna il server.

---

## Parte 6 - Problemi comuni

### Il badge non appare

- Desktop: Tampermonkey non abilitato
- iOS: l'estensione non e attiva su tutti i siti
- Il player impiega 5-10 secondi a iniettare il video

### Badge rosso retry 2s

Il server rifiuta la connessione. Controlla:

    ssh tuo-utente@server
    sudo journalctl -u watch-together -n 30 --no-pager | grep -iE "error|exception"

Se vedi UnboundLocalError, aggiorna il server con l'ultima versione.

### Non riesco ad accedere al pannello admin

    sudo cat /opt/watch-together/.admin_env
    systemctl show -p EnvironmentFiles watch-together
    sudo systemctl restart watch-together

### Lo userscript non si aggiorna

    curl -s https://wt.example.com/wt.user.js | grep "@version"

Se la versione e vecchia, ricopia il file:

    sudo cp /percorso/del/repo/userscript/watch-together.user.js \
            /opt/watch-together/repo/userscript/watch-together.user.js

Poi in Tampermonkey -> Reinstalla.
