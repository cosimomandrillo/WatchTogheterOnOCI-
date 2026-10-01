# Watch Together

Sincronizza la riproduzione di un video HTML5 tra piu dispositivi (iPhone, PC, tablet) tramite un piccolo relay WebSocket. Include chat, notifiche di presenza, stanze permanenti con password, homepage di gestione e pannello admin.

> Il server non trasmette mai il video. Fa da relay per piccoli messaggi JSON (play, pause, seek, tick, chat). Il traffico video resta diretto tra ciascun dispositivo e la sorgente.

## Caratteristiche

### Sincronizzazione

- Sync play / pause / seek con tolleranza anti-loop
- Correzione automatica della deriva ogni 15 s quando in play
- Auto-update URL episodio: quando cambi puntata, la stanza aggiorna il link al volo (preserva ?e=...)
- Riconnessione esponenziale (2s -> 4s -> ... -> 60s)

### Stanze

- Room picker con elenco delle stanze attive
- Stanze permanenti (SQLite): sopravvivono ai riavvii
- Tombstone 5 min: una stanza cancellata dal TTL mantiene la password
- Password opzionale con sistema di ownership
- Solo l'owner puo cambiare la password
- Avatar con immagine: il poster del film viene estratto automaticamente
- Metadati: titolo serie + descrizione episodio mostrati in homepage

### Homepage /watch

- UI moderna: sfondo animato, card glassmorphism, avatar colorati
- Ricerca + filtri (Tutte / Live / Permanenti)
- Login admin per gestire le stanze (modifica/elimina)
- Auto-detect versione script: se il tuo userscript e vecchio, la homepage te lo segnala
- Responsive (iOS / Android / desktop)

### Chat

- Chat per stanza con pallino messaggi non letti
- Notifiche di presenza ("X e entrato / uscito")
- Filtro URL in chat + rate limit 1 msg/sec

### Distribuzione

- Sync dominio StreamingCommunity via GitHub Actions (legge il canale Telegram)
- nginx sub_filter: il tuo dominio viene iniettato nel userscript al volo
- Server leggero: meno di 20 MB RAM, CPU trascurabile
- Nessun flusso video passa dal server

## Requisiti

Server: VPS Linux + Python 3.10+ + Nginx + TLS (Let's Encrypt)

Dominio: un sottodominio puntato al server

Client desktop: browser + Tampermonkey / Violentmonkey

Client iOS: app Userscripts

## Installazione rapida

### Server

    git clone https://github.com/cosimomandrillo/WatchTogheterOnOCI-.git
    cd WatchTogheterOnOCI-
    sudo bash setup/install.sh

Lo script ti chiede dominio e password admin, poi installa tutto.

### Client

1. Installa Tampermonkey (desktop) o Userscripts (iOS)
2. Apri https://IL-TUO-DOMINIO/wt.user.js
3. Conferma l'installazione
4. Apri il player su StreamingCommunity

Per la guida completa: INSTALL.md

## Come si usa

### Primo avvio

1. Apri https://IL-TUO-DOMINIO/watch per vedere le stanze
2. Clicca una stanza -> inserisci nome + password -> Entra
3. Sei sul video, sincronizzato con chi c'e gia

### Creare una stanza permanente

1. Login admin (icona chiave in alto a destra)
2. FAB "Nuova stanza"
3. Compila nome + (opzionale) password + URL iniziale
4. La stanza apparira in home e non verra cancellata quando tutti escono

## Struttura del repository

    WatchTogheterOnOCI-/
    |-- server/
    |   |-- wt_server.py              Relay WebSocket + SQLite
    |   |-- homepage.html             Homepage /watch + pannello admin
    |-- setup/
    |   |-- install.sh                Installer server idempotente
    |-- userscript/
    |   |-- watch-together.user.js    Client Tampermonkey/Userscripts
    |-- tools/
    |   |-- sync_domain.py            Sync dominio SC da Telegram
    |-- .github/workflows/
    |   |-- sync-domain.yml           GitHub Action cron
    |-- README.md
    |-- INSTALL.md

## Configurazione server

Variabili d'ambiente (lette da wt_server.py):

- WT_HOST          (default 127.0.0.1)        Bind address
- WT_PORT          (default 8765)             Porta relay
- WT_ROOM_TTL      (default 300)              Secondi prima che una stanza vuota venga cancellata
- WT_TOMBSTONE_TTL (default 300)              Secondi di tombstone dopo la cancellazione
- WT_DB_PATH       (default rooms.db)         SQLite per stanze persistenti
- WT_ADMIN_USER    (default admin)            Username admin
- WT_ADMIN_PASS    (default vuoto)            Password admin (vuoto = login disabilitato)

Le credenziali admin si trovano in /opt/watch-together/.admin_env (permessi 600) e sono caricate dal servizio systemd.

## Privacy e Sicurezza

- Il relay non vede il video, solo piccoli messaggi JSON
- Chat filtrata: i link vengono rimossi automaticamente
- Rate limit 1 msg/sec per utente
- SQLite contiene solo: nome stanza, password, URL, owner token, metadati

## Licenza

MIT - vedi LICENSE.
