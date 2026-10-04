// ==UserScript==
// @name         Watch Together
// @namespace    watch-together
// @match        *://*/*
// @match        *://*.vixcloud.co/*
// @version      5.0.0
// @description  Sync video + chat + room picker + ownership + autoplay su gesto
// @author       watch-together contributors
// @run-at       document-start
// @grant        none
// @updateURL    https://YOUR_SERVER_HERE/wt.user.js
// @downloadURL  https://YOUR_SERVER_HERE/wt.user.js
// @homepageURL  https://github.com/cosimomandrillo/WatchTogheterOnOCI-
// @supportURL   https://github.com/cosimomandrillo/WatchTogheterOnOCI-/issues
// ==/UserScript==

(function () {
    'use strict';

    // =================================================================
    // BAIL-OUT DINAMICO: nessun dominio SC hardcoded
    // =================================================================
    // Se il dominio NON contiene parole chiave SC comuni, esci subito.
    // Il dominio di StreamingCommunity cambia spesso (Telegram lo
    // comunica), ma contiene quasi sempre "streaming" / "community"
    // / "vixcloud". Se in futuro cambierà forma, basterà aggiungere
    // un pattern qui oppure lasciare che il sync_domain.py aggiorni
    // automaticamente @match (vedi GitHub Actions).
    (function(){
        const SC_PATTERNS = /streaming|community|vixcloud|sc-?watch|watch-?sc/i;
        const host = location.hostname || '';
        if (!SC_PATTERNS.test(host)) {
            // Domini non-SC: esci silenziosamente (nessuna rete, nessun log)
            return;
        }
    })();
    // Se il dominio è valido, proseguiamo (il bail-out è sopra, ma
    // per sicurezza controlliamo anche qui con una variabile)
    if (!/streaming|community|vixcloud|sc-?watch|watch-?sc/i.test(location.hostname || '')) {
        // Esci senza toccare la rete
        return;
    }

    const DEFAULTS = {
        wsUrl:  'wss://YOUR_SERVER_HERE/wt',
        author: 'Anon',
    };

    // =================================================================
    // TOP FRAME LISTENER
    // =================================================================
    const PARENT_REQ  = '__wt_get_parent_url__';
    const PARENT_RESP = '__wt_parent_url__';

    const IS_TOP = (() => {
        try { return window === window.top; } catch (_) { return false; }
    })();

    if (IS_TOP) {
        console.log('[WT][top] caricato su', location.href);
        window.addEventListener('message', (e) => {
            if (e.data && e.data[PARENT_REQ]) {
                console.log('[WT][top] richiesta da', e.origin);
                try {
                    const urlToSend = (typeof __WT_ORIGINAL_HREF !== 'undefined' && __WT_ORIGINAL_HREF)
                        ? __WT_ORIGINAL_HREF
                        : location.href;
                    e.source.postMessage({ [PARENT_RESP]: urlToSend }, '*');
                } catch (err) {
                    console.log('[WT][top] errore:', err);
                }
            }
            if (e.data && e.data.__wt_clear_hash__) {
                try {
                    history.replaceState(null, '', location.pathname + location.search);
                    console.log('[WT][top] hash pulito');
                } catch (_) {}
            }
            if (e.data && e.data.__wt_navigate__ && e.data.url) {
                try {
                    console.log('[WT][top] navigo verso', e.data.url);
                    window.location.href = e.data.url;
                } catch (_) {}
            }
            if (e.data && e.data.__wt_find_next_episode__) {
                let nextUrl = '';
                try { nextUrl = __wt_findNextEpisodeInDom(); } catch (err) {
                    console.log('[WT][top] findNext errore:', err);
                }
                console.log('[WT][top] findNext =', nextUrl);
                try {
                    e.source.postMessage({ __wt_next_episode_url__: nextUrl }, '*');
                } catch (_) {}
            }
        });
    } else {
        console.log('[WT][iframe] caricato su', location.href);

        if (/\/it\/iframe\/\d+/.test(location.pathname)) {
            window.addEventListener('message', function (e) {
                if (!e.data || !e.data.__wt_ask_ep__) return;
                // Siamo same-origin col top: leggiamo l'URL reale, niente
                // ricostruzione ambigua da episode_id (evita ep1<->ep2 mismatch).
                var cand = '';
                try { cand = window.top.location.href; } catch (_) { cand = location.href; }
                try { cand = cand.split('#')[0]; } catch (_) {}
                try { e.source.postMessage({ __wt_ep_result__: cand }, '*'); } catch (_) {}
            });
        }

        // Se un discendente (vixcloud, cross-origin) ci chiede di trovare
        // e navigare al prossimo episodio, facciamo il lavoro noi perche'
        // siamo same-origin col TOP (/it/iframe/61 <-> /it/watch/61).
        window.addEventListener('message', function (e) {
            if (!e.data || !e.data.__wt_goto_next__) return;
            let topUrl = '';
            try { topUrl = window.top.location.href; } catch (_) { topUrl = location.href; }
            let nextUrl = '';
            try { nextUrl = __wt_scanDocForNext(window.top.document, topUrl); } catch (_) {}
            if (!nextUrl) {
                try { nextUrl = __wt_scanDocForNext(document, location.href); } catch (_) {}
            }
            console.log('[WT][sc-iframe] goto_next richiesto, trovato:', nextUrl);
            try {
                e.source.postMessage({ __wt_goto_next_result__: true, url: nextUrl || '' }, '*');
            } catch (_) {}
            if (nextUrl) {
                setTimeout(function () {
                    try { window.top.location.href = nextUrl; }
                    catch (_) {
                        try { window.location.href = nextUrl; } catch (__) {}
                    }
                }, 200);
            }
        });
    }

    function __wt_findNextEpisodeInDom() {
        try {
            const doc = document;
            const curHref = location.href;
            const curM = curHref.match(/[?&]e=(\d+)/);
            const curE = curM ? parseInt(curM[1], 10) : null;

            // Tutti i link "episodio" con ?e=NNN nella pagina
            const anchors = Array.from(doc.querySelectorAll('a[href*="/it/watch/"]'));
            const eps = [];
            anchors.forEach(function (a) {
                const h = a.getAttribute('href') || '';
                const m = h.match(/[?&]e=(\d+)/);
                if (!m) return;
                const e = parseInt(m[1], 10);
                let abs;
                try { abs = new URL(h, location.origin).href; } catch (_) { abs = ''; }
                if (abs) eps.push({ e: e, url: abs, el: a });
            });
            if (!eps.length) return '';

            // Deduplica per e
            const byE = {};
            eps.forEach(function (x) { if (!byE[x.e]) byE[x.e] = x; });
            const sorted = Object.values(byE).sort(function (a, b) { return a.e - b.e; });

            // Caso 1: URL corrente ha ?e=NNN → primo episodio con e > curE
            if (curE !== null) {
                const nxt = sorted.find(function (x) { return x.e > curE; });
                return nxt ? nxt.url : '';
            }

            // Caso 2: niente ?e= nell'URL → link marcato "active/current/playing"
            const active = eps.find(function (x) {
                return /active|current|playing|selected/i.test(x.el.className || '');
            });
            if (active) {
                const idx = sorted.findIndex(function (x) { return x.e === active.e; });
                if (idx >= 0 && sorted[idx + 1]) return sorted[idx + 1].url;
            }

            // Caso 3: primo link nella lista se nessuno è marcato
            return sorted.length ? sorted[0].url : '';
        } catch (_) {
            return '';
        }
    }

    // Bail-out homepage statica
    if (IS_TOP && location.pathname === '/watch'
        && !/(vixcloud|streamingcommunity)/i.test(location.hostname)) {
        return;
        }

        // =================================================================
        // HASH parsing sincrono (prima di qualsiasi await)
        // =================================================================
        let BOOT_HASH_ROOM = null;
    let BOOT_HASH_PASS = '';
    let BOOT_HASH_PERSISTENT = false;
    let BOOT_HASH_OWNER = '';
    let BOOT_HASH_AUTHOR = '';
    var __WT_ORIGINAL_HREF = location.href;
    try {
        const _hash = location.hash.replace(/^#/, '');
        if (_hash) {
            const _params = new URLSearchParams(_hash);
            const _r = _params.get('wt_room');
            if (_r) {
                BOOT_HASH_ROOM = _r;
                BOOT_HASH_PASS = _params.get('wt_pass') || '';
                BOOT_HASH_PERSISTENT = _params.get('wt_persistent') === '1';
                BOOT_HASH_OWNER = _params.get('wt_owner') || '';
                BOOT_HASH_AUTHOR = _params.get('wt_author') || '';
                history.replaceState(null, '', location.pathname + location.search);
                try {
                    localStorage.setItem('wt_room', _r);
                    if (BOOT_HASH_PASS) localStorage.setItem('wt_pass', BOOT_HASH_PASS);
                    if (BOOT_HASH_AUTHOR) localStorage.setItem('wt_author', BOOT_HASH_AUTHOR);
                } catch (_) {}
                console.log('[WT] hash rimosso, stanza:', _r);
            }
        }
    } catch (_) {}

    const DEBUG = true;
    function log(...a) { if (DEBUG) console.log('[WT]', ...a); }

    function __wt_sendDebugAdHoc(msg) {
        try {
            const url = (typeof DEFAULTS !== 'undefined' && DEFAULTS.wsUrl && !DEFAULTS.wsUrl.includes('YOUR'))
                ? DEFAULTS.wsUrl
                : (function(){ try { return localStorage.getItem('wt_ws_url') || ''; } catch(_) { return ''; } })();
            if (!url) return;
            const s = new WebSocket(url);
            s.onopen = function () {
                try { s.send(JSON.stringify({ type: 'debug', msg: msg })); } catch (_) {}
                setTimeout(function(){ try { s.close(); } catch(_){} }, 300);
            };
            s.onerror = function(){ try { s.close(); } catch(_){} };
        } catch (_) {}
    }
    (function __wt_boot_debug__() {
        var frame = (function(){ try { return window === window.top ? 'TOP' : 'IFRAME'; } catch(_) { return 'IFRAME-X'; } })();
        var host = location.hostname || '?';
        var href = (location.href || '').slice(0, 100);
        var msg = 'BOOT host=' + host + ' frame=' + frame + ' href=' + href;
        try { console.log('[WT]', msg); } catch(_) {}
        __wt_sendDebugAdHoc(msg);
    })();

    if (DEFAULTS.wsUrl.includes('YOUR' + '_SERVER_HERE')) {
        setTimeout(() => {
            alert(
                'Watch Together non configurato.\n\n' +
                'Sostituisci "YOUR' + '_SERVER_HERE" con il dominio del tuo server.'
            );
        }, 2000);
        return;
    }

    const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent)
    || window.matchMedia('(max-width: 500px)').matches;

    const CLIENT_ID_KEY = 'wt_client_id';
    let clientId = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
        clientId = 'c_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        sessionStorage.setItem(CLIENT_ID_KEY, clientId);
    }

    const LS = {
        wsUrl:  'wt_ws_url',
 room:   'wt_room',
 pass:   'wt_pass',
 author: 'wt_author',
    };

    const URL_IGNORE_PARAMS = [
        'token', 'sig', 'signature', 'expires', 'auth', 't', '_', 'ts', 'nonce', 'hash'
    ];
    const PENDING_KEY = 'wt_pending_room';

    // =================================================================
    // URL RESOLUTION
    // =================================================================
    const VIDEO_URL_RE = /\/(?:it\/)?watch\/\d+|\/it\/iframe\/\d+/;

    function resolvePageUrl() {
        return new Promise((resolve) => {
            if (IS_TOP) { resolve(location.href); return; }

            const ref = document.referrer || '';
            if (ref && VIDEO_URL_RE.test(ref)) {
                log('URL via referrer:', ref);
                const mIframe = ref.match(/(https?:\/\/[^\/]+)\/it\/iframe\/(\d+)/);
                if (mIframe) {
                    const watchUrl = mIframe[1] + '/it/watch/' + mIframe[2];
                    resolve(watchUrl);
                    return;
                }
                resolve(ref);
                return;
            }
            if (ref) log('referrer ignorato:', ref);

            let done = false;
            const handler = (e) => {
                if (e.data && e.data[PARENT_RESP]) {
                    let url = e.data[PARENT_RESP];
                    if (!VIDEO_URL_RE.test(url)) {
                        log('postMessage non video:', url);
                        return;
                    }

                    // *** CRITICO: l'iframe non vede location.hash del top,
                    // quindi estrai hash e query dall'URL ricevuto ***
                    try {
                        const u = new URL(url);
                        if (u.hash && !BOOT_HASH_ROOM) {
                            const params = new URLSearchParams(u.hash.replace(/^#/, ''));
                            const rFromHash = params.get('wt_room');
                            if (rFromHash) {
                                BOOT_HASH_ROOM = rFromHash;
                                BOOT_HASH_PASS = params.get('wt_pass') || '';
                                BOOT_HASH_PERSISTENT = params.get('wt_persistent') === '1';
                                BOOT_HASH_OWNER = params.get('wt_owner') || '';
                                BOOT_HASH_AUTHOR = params.get('wt_author') || '';
                                log('hash ricevuto dal top:', rFromHash, 'pass:', BOOT_HASH_PASS ? '***' : '(vuota)');
                                // Chiedi al top di pulire l'hash dall'URL
                                try {
                                    window.top.postMessage({ __wt_clear_hash__: true }, '*');
                                } catch (_) {}
                            }
                        }
                    } catch (err) {
                        log('errore parse hash:', err);
                    }

                    // Converti /it/iframe/NNN → /it/watch/NNN per uniformità
                    const mIf = url.match(/(https?:\/\/[^\/]+)\/it\/iframe\/(\d+)/);
                    if (mIf) {
                        url = mIf[1] + '/it/watch/' + mIf[2];
                        log('iframe convertito in:', url);
                    }

                    // Rimuovi l'hash dall'URL (per non inquinare il server)
                    url = url.split('#')[0];

                    done = true;
                    window.removeEventListener('message', handler);
                    log('URL via postMessage:', url);
                    resolve(url);
                }
            };
            window.addEventListener('message', handler);

            [0, 200, 500, 1000, 2000, 3500, 5000].forEach((delay) => {
                setTimeout(() => {
                    if (done) return;
                    try { window.top.postMessage({ [PARENT_REQ]: true }, '*'); }
                    catch (_) {}
                }, delay);
            });

            setTimeout(() => {
                if (done) return;
                window.removeEventListener('message', handler);
                log('timeout URL');
                resolve('');
            }, 6000);
        });
    }

    function normalizeUrl(url) {
        const target = url || location.href;
        try {
            const u = new URL(target);
            const params = new URLSearchParams(u.search);
            for (const key of Array.from(params.keys())) {
                if (URL_IGNORE_PARAMS.includes(key.toLowerCase())) params.delete(key);
            }
            const clean = params.toString();
            return u.origin + u.pathname + (clean ? '?' + clean : '');
        } catch (_) {
            return target;
        }
    }

    

    

    const EPISODE_PARAMS = ['e', 'ep', 'episode', 'episode_id', 's', 'season'];

            function extractRoomImage() {
        try {
            var og = document.querySelector('meta[property="og:image"]');
            if (og) {
                var u = og.getAttribute('content');
                if (u && /^https?:\/\//.test(u)) return u.slice(0, 300);
            }
            var img = document.querySelector('.video-poster img, .poster img, img.video-thumb');
            if (img && img.src) return img.src.slice(0, 300);
        } catch (_) {}
        return '';
    }

function extractVideoMeta() {
        var title = '';
        var description = '';
        try {
            // Selettori specifici StreamingCommunity
            var t = document.querySelector('.video-title');
            if (t) title = (t.textContent || '').trim();
            if (!title) t = document.querySelector('.film-title, .serie-title, h1.title, .title');
            if (t && !title) title = (t.textContent || '').trim();

            var d = document.querySelector('.video-description');
            if (d) description = (d.textContent || '').trim();
            if (!description) d = document.querySelector('.film-description, .episode-title, .episode-info');
            if (d && !description) description = (d.textContent || '').trim();

            // Fallback meta OG
            if (!title) {
                var og = document.querySelector('meta[property="og:title"]');
                if (og) title = (og.getAttribute('content') || '').trim();
            }
            if (!description) {
                var ogd = document.querySelector('meta[property="og:description"]');
                if (ogd) description = (ogd.getAttribute('content') || '').trim();
            }
            // Fallback <title>
            if (!title && document.title) title = document.title.split('|')[0].trim();
        } catch (_) {}
        return {
            title: title.replace(/\s+/g, ' ').slice(0, 200),
            description: description.replace(/\s+/g, ' ').slice(0, 300)
        };
    }

function extractVideoUrl(url) {
        if (!url) return '';
        var m = url.match(/(https?:\/\/[^\/]+\/(?:it\/)?watch\/\d+)(\?[^\s#]*)?/);
        if (m) {
            var base = m[1];
            var q = m[2] || '';
            if (!q) {
                var qi = url.indexOf('?');
                if (qi !== -1) {
                    var after = url.slice(qi);
                    var end = after.search(/[#\s]/);
                    q = end === -1 ? after : after.slice(0, end);
                }
            }
            if (!q) return base;
            try {
                var params = new URLSearchParams(q.slice(1));
                var keep = new URLSearchParams();
                for (var kv of params) {
                    if (EPISODE_PARAMS.indexOf(kv[0].toLowerCase()) !== -1) keep.set(kv[0], kv[1]);
                }
                var clean = keep.toString();
                return base + (clean ? '?' + clean : '');
            } catch (_) { return base; }
        }
        m = url.match(/(https?:\/\/[^\/]+)\/it\/iframe\/(\d+)/);
        if (m) return m[1] + '/it/watch/' + m[2];
        return '';
    }

    function shortUrl(url, max) {
        if (!url) return '';
        try {
            const u = new URL(url);
            let s = u.hostname + u.pathname + u.search;
            const lim = max || 40;
            if (s.length > lim) s = s.slice(0, lim - 1) + '…';
            return s;
        } catch (_) {
            return url.slice(0, max || 40);
        }
    }

    const THRESHOLD_PLAY  = 1.5;
    const THRESHOLD_PAUSE = 0.5;
    const THRESHOLD_TICK  = 3.0;
    const TICK_INTERVAL   = 15000;
    const RECONNECT_MIN   = 2000;
    const RECONNECT_MAX   = 60000;
    const LOCK_MS         = 250;

    const THEME = {
        bg:          'rgba(18, 18, 22, 0.55)',
 bgSoft:      'rgba(28, 28, 34, 0.98)',
 border:      'rgba(255, 255, 255, 0.14)',
 text:        '#ffffff',
 textMuted:   '#9a9aa3',
 accent:      '#22c55e',
 danger:      '#ef4444',
 warn:        '#f59e0b',
 ok:          '#22c55e',
 gold:        '#fbbf24',
 link:        '#60a5fa',
 ownBubble:   'rgba(34, 197, 94, 0.22)',
 otherBubble: 'rgba(255, 255, 255, 0.09)',
    };

    let video = null;
    let ws = null;
    let lock = false;
    let connected = false;
    let authFailed = false;
    let isOwner = false;
    let ownerToken = '';
    let reconnectDelay = RECONNECT_MIN;
    let badge, badgeDot, badgeLabel, badgeUnread;
    let sheet, sheetList, sheetInput;
    let optionsPanel = null;
    let roomPickerEl = null;
    let room, author, pass, wsUrl;
    let pageUrl = null;
    let unread = 0, sheetOpen = false, optionsOpen = false;
    let tickTimer = null;
    let listenersAttached = false;
    let pendingPlayTarget = null;
    let autoReconnect = false;
    let persistent = false;
    let autoplayArmed = false;
    let pendingNavigateFlag = false;

    function pickVideo() {
        const vids = Array.from(document.querySelectorAll('video')).filter(v => v.readyState >= 1);
        if (!vids.length) return null;
        return vids.reduce((best, v) => {
            const area = (v.clientWidth || 0) * (v.clientHeight || 0);
            const bestArea = best ? (best.clientWidth * best.clientHeight) : -1;
            return area > bestArea ? v : best;
        }, null);
    }

    log('cerco <video>…');
    const waitVideo = setInterval(() => {
        const v = pickVideo();
        if (v) {
            clearInterval(waitVideo);
            video = v;
            log('video trovato');
            boot();
        }
    }, 500);

    function loadConfig() {
        wsUrl  = localStorage.getItem(LS.wsUrl)  || DEFAULTS.wsUrl;
        room   = localStorage.getItem(LS.room)   || null;
        pass   = localStorage.getItem(LS.pass)   || '';
        author = localStorage.getItem(LS.author) || null;
    }
    function saveConfig() {
        localStorage.setItem(LS.wsUrl,  wsUrl);
        if (room) localStorage.setItem(LS.room, room); else localStorage.removeItem(LS.room);
        localStorage.setItem(LS.pass,   pass || '');
        localStorage.setItem(LS.author, author || '');
    }
    function getOwnerToken(r) { return localStorage.getItem('wt_owner_' + r) || ''; }
    function setOwnerToken(r, tok) {
        if (tok) localStorage.setItem('wt_owner_' + r, tok);
        else localStorage.removeItem('wt_owner_' + r);
    }

    async function boot() {
        loadConfig();
        buildUI();
        attachVideoListeners();
        attachNextEpisodeInterceptor();

        pageUrl = await resolvePageUrl();
        log('pageUrl:', pageUrl);
        log('videoUrl:', extractVideoUrl(pageUrl));

        if (!extractVideoUrl(pageUrl)) {
            log('URL non risolto, ritento tra 3s');
            setStatus('connecting', 'Risoluzione URL…');
            setTimeout(async () => {
                pageUrl = await resolvePageUrl();
                const vu = extractVideoUrl(pageUrl);
                log('retry URL:', vu);
                if (!vu) { setStatus('error', 'URL video non trovato'); return; }
                proceedAfterUrl();
            }, 3000);
            return;
        }
        proceedAfterUrl();
    }

    function proceedAfterUrl() {
        try {
            const pendNav = sessionStorage.getItem('wt_pending_navigate') === '1';
            const follNav = sessionStorage.getItem('wt_following_navigate') === '1';
            sessionStorage.removeItem('wt_pending_navigate');
            sessionStorage.removeItem('wt_following_navigate');
            pendingNavigateFlag = pendNav && !follNav;
            if (pendingNavigateFlag) log('pending navigate flag attivo');
        } catch (_) {}

        const hashRoom = BOOT_HASH_ROOM;
        const hashPass = BOOT_HASH_PASS;

        let pending = null;
        try {
            const raw = sessionStorage.getItem(PENDING_KEY);
            if (raw) {
                pending = JSON.parse(raw);
                sessionStorage.removeItem(PENDING_KEY);
            }
        } catch (_) {}

        // pending (navigazione in-app) ha priorita' su hash stale
        if (pending && pending.name) {
            room = pending.name;
            pass = pending.pass || '';
            if (pending.owner) setOwnerToken(room, pending.owner);
            saveConfig();
            if (!author) askAuthor(() => connect());
            else connect();
            return;
        }

        if (hashRoom) {
            room = hashRoom;
            pass = hashPass;
            if (BOOT_HASH_AUTHOR) author = BOOT_HASH_AUTHOR;
            if (BOOT_HASH_OWNER) setOwnerToken(room, BOOT_HASH_OWNER);
            autoReconnect = false;
            persistent = BOOT_HASH_PERSISTENT;
            saveConfig();
            if (!author) askAuthor(() => connect());
            else connect();
            return;
        }

        if (!room) {
            autoReconnect = false;
            setStatus('connecting', 'Scegli stanza');
            openRoomPicker();
        } else if (!author) {
            autoReconnect = true;
            askAuthor(() => connect());
        } else {
            autoReconnect = true;
            connect();
        }
    }

    function attachVideoListeners() {
        if (listenersAttached) return;
        listenersAttached = true;
        // iOS: playsinline obbligatorio per autoplay muto
        try {
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.playsInline = true;
        } catch (_) {}
        video.addEventListener('play', () => { startTicker(); send({ type: 'play', t: video.currentTime }); });
        video.addEventListener('pause', () => { stopTicker(); send({ type: 'pause', t: video.currentTime }); });
        video.addEventListener('seeked', () => { send({ type: 'seek', t: video.currentTime }); });
    }


    // =================================================================
    // INTERCETTA "PROSSIMO EPISODIO" e chiedi conferma
    // =================================================================
    function nextEpisodeUrl(url) {
        if (!url) return '';
        if (/[?&]e=\d+/.test(url)) {
            return url.replace(/([?&]e=)(\d+)/, function (_, pre, num) {
                return pre + (parseInt(num, 10) + 1);
            });
        }
        if (/[?&]episode_id=\d+/.test(url)) {
            return url.replace(/([?&]episode_id=)(\d+)/, function (_, pre, num) {
                return pre + (parseInt(num, 10) + 1);
            });
        }
        return '';
    }

    let __wt_lastDebugClick = 0;
    function __wt_logClick(kind, e) {
        const now = Date.now();
        if (now - __wt_lastDebugClick < 600) return;
        __wt_lastDebugClick = now;
        try {
            const t = e.target;
            if (!t) return;
            const tag = t.tagName || '?';
            const cls = String(t.className || '').slice(0, 100);
            const pEl = t.parentElement;
            const pcls = pEl ? String(pEl.className || '').slice(0, 100) : '';
            const msg = kind + ' <' + tag + '> cls="' + cls + '" parent="' + pcls + '"';
            if (typeof connected !== 'undefined' && connected && ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'debug', msg: msg }));
            } else {
                __wt_sendDebugAdHoc(msg);
            }
        } catch (_) {}
    }

    // Cerca link del prossimo episodio: prima nel TOP (same-origin),
    // poi in eventuali altri documenti accessibili, infine in sé stesso.
    function __wt_scanDocForNext(doc, topHref) {
        if (!doc) return '';
        let anchors;
        try {
            anchors = Array.from(doc.querySelectorAll(
                'a[href*="/it/watch/"], a[href*="/watch/"], a[href*="episode_id="], a[href*="?e="]'
            ));
        } catch (_) { return ''; }
        if (!anchors.length) return '';

        const eps = [];
        anchors.forEach(function (a) {
            let h = a.getAttribute('href') || '';
            if (!h) return;
            const m = h.match(/[?&](?:e|episode_id)=(\d+)/);
            if (!m) return;
            let abs;
            try { abs = new URL(h, topHref || location.origin).href; } catch (_) { return; }
            eps.push({ e: parseInt(m[1], 10), url: abs, el: a });
        });
        if (!eps.length) return '';

        const byE = {};
        eps.forEach(function (x) { if (!byE[x.e]) byE[x.e] = x; });
        const sorted = Object.keys(byE).map(function (k) { return byE[k]; })
            .sort(function (a, b) { return a.e - b.e; });

        const curM = (topHref || '').match(/[?&](?:e|episode_id)=(\d+)/);
        const curE = curM ? parseInt(curM[1], 10) : null;

        if (curE !== null) {
            const nxt = sorted.find(function (x) { return x.e > curE; });
            if (nxt) return nxt.url;
        }

        const active = eps.find(function (x) {
            return /active|current|playing|selected|episode-item-active/i.test(
                (x.el.className || '') + ' ' + (x.el.parentElement ? x.el.parentElement.className : '')
            );
        });
        if (active) {
            const idx = sorted.findIndex(function (x) { return x.e === active.e; });
            if (idx >= 0 && sorted[idx + 1]) return sorted[idx + 1].url;
        }

        return sorted.length ? sorted[0].url : '';
    }

    function __wt_findNextEpisodeOnPage() {
        let topHref = '';
        let topDoc = null;
        let parentDoc = null;
        try { topHref = window.top.location.href; } catch (_) {
            try { topHref = location.href; } catch (__) {}
        }
        try { topDoc = window.top.document; } catch (_) {}
        try { parentDoc = window.parent && window.parent !== window ? window.parent.document : null; } catch (_) {}

        const docs = [];
        if (topDoc) docs.push(topDoc);
        if (parentDoc && parentDoc !== topDoc) docs.push(parentDoc);
        docs.push(document);

        for (let i = 0; i < docs.length; i++) {
            try {
                const url = __wt_scanDocForNext(docs[i], topHref);
                if (url) {
                    log('next-episode trovato nel doc #' + i + ':', url);
                    return url;
                }
            } catch (_) {}
        }
        return '';
    }

    function attachNextEpisodeInterceptor() {
        if (window.__wt_next_ep_hooked) return;
        window.__wt_next_ep_hooked = true;

        document.addEventListener('click', function (e) {
            const t = e.target;
            if (!t || !t.closest) return;
            const btn = t.closest('.next-episode, .jw-icon-next-episode, [aria-label*="prossim"], [aria-label*="Next"]');
            if (!btn) return;

            __wt_logClick('CLICK-NEXT', e);

            const ok = window.confirm(
                'Sicuro di voler passare al prossimo episodio?\n\n' +
                'Tutti i partecipanti della stanza verranno spostati ' +
                'sul nuovo link.'
            );
            if (ok) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }, true);
    }

    // =================================================================
    function el(tag, style, ...children) {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        children.forEach(c => {
            if (typeof c === 'string') e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        });
            return e;
    }

    function onTap(node, handler) {
        let fired = false;
        const wrapped = (ev) => {
            if (fired) return;
            fired = true;
            setTimeout(() => fired = false, 300);
            handler(ev);
        };
        node.addEventListener('click', wrapped);
        if (IS_IOS) {
            node.addEventListener('touchend', (e) => { e.preventDefault(); wrapped(e); }, { passive: false });
        }
    }

    // =================================================================
    function buildUI() {
        if (!document.body) {
            const wait = setInterval(() => {
                if (document.body) { clearInterval(wait); buildUI(); }
            }, 50);
            return;
        }
        if (document.getElementById('__wt_badge__')) return;

        const badgeTop = IS_MOBILE ? 'calc(10px + env(safe-area-inset-top, 0px))' : '14px';
        const badgeH   = IS_MOBILE ? 48 : 40;
        const dotSize  = IS_MOBILE ? 14 : 12;

        badge = el('div', [
            'position:fixed', 'top:' + badgeTop, 'right:14px',
            'z-index:2147483647',
            'transform:translateZ(0)',
                   'will-change:transform',
                   'isolation:isolate',
                   'background:rgba(20, 20, 25, 0.98)',
                   'color:#ffffff',
                   'border:1.5px solid rgba(255,255,255,0.28)',
                   'border-radius:' + (badgeH / 2) + 'px',
                   'padding:0 14px 0 12px',
                   'height:' + badgeH + 'px',
                   'min-width:' + (IS_MOBILE ? 96 : 80) + 'px',
                   'box-sizing:border-box',
                   'display:flex', 'align-items:center', 'gap:9px',
                   'font:600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                   'cursor:pointer',
                   'user-select:none',
                   '-webkit-user-select:none',
                   '-webkit-tap-highlight-color:transparent',
                   'box-shadow:0 4px 24px rgba(0,0,0,.85), 0 0 0 1px rgba(0,0,0,.4)',
                   'max-width:calc(100vw - 28px)',
                   'overflow:hidden'
        ].join(';'));
        badge.id = '__wt_badge__';

        badgeDot = document.createElement('span');
        badgeDot.style.cssText = [
            'display:inline-block',
            'width:' + dotSize + 'px', 'height:' + dotSize + 'px',
            'min-width:' + dotSize + 'px', 'min-height:' + dotSize + 'px',
            'border-radius:50%',
            'background:#f59e0b',
            'box-shadow:0 0 0 3px rgba(245,158,11,.25), 0 0 10px rgba(245,158,11,.6)',
 'flex-shrink:0', 'vertical-align:middle', 'box-sizing:border-box'
        ].join(';');
        badge.appendChild(badgeDot);

        badgeLabel = el('span', [
            'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
            'max-width:50vw', 'color:#ffffff',
            'flex:0 1 auto', 'min-width:0'
        ].join(';'), 'WT');
        badge.appendChild(badgeLabel);

        badgeUnread = el('span', [
            'display:none', 'min-width:20px', 'height:20px',
            'background:' + THEME.danger, 'color:#fff',
            'border-radius:10px',
            'font:700 11px/20px -apple-system, sans-serif',
            'text-align:center', 'padding:0 6px',
            'margin-left:2px', 'flex-shrink:0', 'box-sizing:border-box'
        ].join(';'));
        badge.appendChild(badgeUnread);

        onTap(badge, () => sheetOpen ? closeSheet() : openSheet());

        sheet = el('div', [
            'position:fixed', 'z-index:2147483646',
            'background:' + THEME.bg,
            'border:1px solid ' + THEME.border,
            'color:' + THEME.text,
            'display:none', 'flex-direction:column', 'overflow:hidden',
            'font:14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'backdrop-filter:blur(22px) saturate(160%)',
            '-webkit-backdrop-filter:blur(22px) saturate(160%)',
            'transition:transform .25s cubic-bezier(.32,.72,0,1), opacity .2s ease'
        ].join(';'));

        if (IS_MOBILE) {
            sheet.style.cssText += ';left:0;right:0;bottom:0;height:45dvh;max-height:45dvh;' +
            'border-radius:18px 18px 0 0;border-bottom:0;transform:translateY(100%);' +
            'box-shadow:0 -8px 40px rgba(0,0,0,.7)';
        } else {
            sheet.style.cssText += ';top:64px;right:14px;width:420px;max-height:600px;' +
            'border-radius:14px;transform:translateY(-8px) scale(.98);' +
            'box-shadow:0 12px 40px rgba(0,0,0,.6)';
        }

        const header = el('div', [
            'padding:12px 16px',
            'border-bottom:1px solid ' + THEME.border,
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'flex-shrink:0',
            'background:' + THEME.bgSoft
        ].join(';'));

        const headerLeft = el('div', 'display:flex;align-items:center;gap:10px;min-width:0;');
        const headerDot = el('span', [
            'display:inline-block',
            'width:10px', 'height:10px',
            'min-width:10px', 'min-height:10px',
            'border-radius:50%',
            'background:' + THEME.warn, 'flex-shrink:0'
        ].join(';'));
        headerDot.id = '__wt_header_dot__';
        headerLeft.appendChild(headerDot);

        const headerTitle = el('div', 'font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'Chat');
        headerTitle.id = '__wt_header_title__';
        headerLeft.appendChild(headerTitle);
        header.appendChild(headerLeft);

        const headerRight = el('div', 'display:flex;align-items:center;gap:4px;flex-shrink:0;');
        const gearBtn = el('button', [
            'background:transparent', 'border:0', 'color:' + THEME.textMuted,
            'width:36px', 'height:36px', 'border-radius:8px', 'cursor:pointer',
            'font-size:18px', 'padding:0',
            'display:flex', 'align-items:center', 'justify-content:center',
            '-webkit-tap-highlight-color:transparent'
        ].join(';'), '⚙');
        onTap(gearBtn, (e) => { e.stopPropagation(); closeSheet(); openOptions(); });
        headerRight.appendChild(gearBtn);

        const closeBtn = el('button', [
            'background:transparent', 'border:0', 'color:' + THEME.textMuted,
            'width:36px', 'height:36px', 'border-radius:8px', 'cursor:pointer',
            'font-size:22px', 'padding:0',
            'display:flex', 'align-items:center', 'justify-content:center',
            '-webkit-tap-highlight-color:transparent'
        ].join(';'), '×');
        onTap(closeBtn, closeSheet);
        headerRight.appendChild(closeBtn);
        header.appendChild(headerRight);
        sheet.appendChild(header);

        sheetList = el('div', [
            'flex:1', 'overflow-y:auto', 'padding:14px',
            'display:flex', 'flex-direction:column', 'gap:8px',
            'scroll-behavior:smooth',
            '-webkit-overflow-scrolling:touch'
        ].join(';'));
        sheet.appendChild(sheetList);

        const inputRow = el('div', [
            'padding:10px 12px',
            'border-top:1px solid ' + THEME.border,
            'display:flex', 'gap:8px',
            'flex-shrink:0',
            'background:' + THEME.bgSoft,
            'padding-bottom:calc(10px + env(safe-area-inset-bottom, 0px) + ' + (IS_MOBILE ? '28px' : '0px') + ')'
        ].join(';'));

        sheetInput = el('input', [
            'flex:1',
            'background:rgba(255,255,255,.06)',
                        'border:1px solid ' + THEME.border,
                        'color:' + THEME.text,
                        'padding:10px 14px',
                        'border-radius:20px',
                        'font:16px -apple-system, sans-serif',
                        'outline:none',
                        'min-width:0',
                        'box-sizing:border-box',
                        '-webkit-appearance:none',
                        'appearance:none',
                        'touch-action:manipulation',
                        'text-size-adjust:100%',
                        '-webkit-text-size-adjust:100%'
        ].join(';'));
        sheetInput.type = 'text';
        sheetInput.placeholder = 'Scrivi un messaggio…';
        sheetInput.maxLength = 500;
        sheetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
        inputRow.appendChild(sheetInput);

        const sendBtn = el('button', [
            'background:' + THEME.accent, 'color:#fff', 'border:0',
            'width:44px', 'height:44px', 'border-radius:50%',
            'cursor:pointer', 'font-size:18px', 'padding:0',
            'display:flex', 'align-items:center', 'justify-content:center',
            'flex-shrink:0',
            '-webkit-tap-highlight-color:transparent',
            'touch-action:manipulation'
        ].join(';'), '➤');
        onTap(sendBtn, sendChat);
        inputRow.appendChild(sendBtn);

        sheet.appendChild(inputRow);

        optionsPanel = buildOptionsPanel();

        document.body.appendChild(sheet);
        document.body.appendChild(badge);
        document.body.appendChild(optionsPanel);

        document.addEventListener('mousedown', (e) => {
            if (!sheetOpen && !optionsOpen) return;
            if (sheet.contains(e.target)) return;
            if (optionsPanel.contains(e.target)) return;
            if (badge.contains(e.target)) return;
            closeSheet();
            closeOptions();
        }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeSheet(); closeOptions(); }
        });
    }

    // =================================================================
    function buildOptionsPanel() {
        const p = el('div', [
            'position:fixed', 'z-index:2147483646',
            'background:' + THEME.bg,
            'border:1px solid ' + THEME.border,
            'color:' + THEME.text,
            'display:none', 'flex-direction:column',
            'padding:18px',
            'font:14px/1.5 -apple-system, sans-serif',
            'backdrop-filter:blur(22px) saturate(160%)',
            '-webkit-backdrop-filter:blur(22px) saturate(160%)'
        ].join(';'));

        if (IS_MOBILE) {
            p.style.cssText += ';left:0;right:0;bottom:0;border-radius:18px 18px 0 0;border-bottom:0;' +
            'max-height:75dvh;overflow-y:auto;' +
            'padding-bottom:calc(20px + env(safe-area-inset-bottom, 0px) + 28px);' +
            'transform:translateY(100%);transition:transform .25s cubic-bezier(.32,.72,0,1);' +
            'box-shadow:0 -8px 40px rgba(0,0,0,.7)';
        } else {
            p.style.cssText += ';top:64px;right:14px;width:360px;border-radius:14px;' +
            'box-shadow:0 12px 40px rgba(0,0,0,.6)';
        }

        const title = el('div', 'font-weight:600;font-size:16px;margin-bottom:16px;display:flex;align-items:center;gap:8px');
        title.appendChild(el('span', 'color:' + THEME.accent + ';font-size:17px;', '⚙'));
        title.appendChild(el('span', '', 'Impostazioni Watch Together'));
        p.appendChild(title);

        const ownerBox = el('div', [
            'display:none', 'margin-bottom:14px', 'padding:12px',
            'background:rgba(251,191,36,0.08)',
                            'border:1px solid rgba(251,191,36,0.3)',
                            'border-radius:10px'
        ].join(';'));
        ownerBox.id = '__wt_owner_box__';
        const ownerTitle = el('div', 'font-weight:600;font-size:13px;color:' + THEME.gold + ';margin-bottom:6px;display:flex;align-items:center;gap:6px');
        ownerTitle.appendChild(el('span', '', '👑'));
        ownerTitle.appendChild(el('span', '', 'Sei il proprietario di questa stanza'));
        ownerBox.appendChild(ownerTitle);
        const pwdBtn = el('button', [
            'background:' + THEME.gold, 'color:#1a1a1a', 'border:0',
            'padding:9px 14px', 'border-radius:8px', 'cursor:pointer',
            'font:600 13px -apple-system, sans-serif',
            'margin-top:6px',
            '-webkit-tap-highlight-color:transparent'
        ].join(';'), 'Cambia password stanza');
        onTap(pwdBtn, () => {
            const np = prompt(
                'Nuova password per "' + room + '"\n' +
                '(lascia vuoto per rimuovere):',
                              ''
            );
            if (np === null) return;
            if (np.length > 64) { alert('Massimo 64 caratteri.'); return; }
            if (!connected || ws.readyState !== 1) {
                alert('Non sei connesso.');
                return;
            }
            ws.send(JSON.stringify({
                type: 'set-password',
                room: room, pass: pass,
                newPass: np,
                ownerToken: ownerToken,
            }));
            pass = np;
            saveConfig();
        });
        ownerBox.appendChild(pwdBtn);
        p.appendChild(ownerBox);

        function field(labelTxt, key, type, placeholder) {
            const wrap = el('div', 'margin-bottom:14px');
            const lbl = el('div', [
                'color:' + THEME.textMuted,
                'font-size:11px', 'font-weight:600',
                'margin-bottom:6px',
                'text-transform:uppercase',
                'letter-spacing:.6px'
            ].join(';'), labelTxt);
            const inp = el('input', [
                'width:100%', 'box-sizing:border-box',
                'background:rgba(255,255,255,.06)',
                           'border:1px solid ' + THEME.border,
                           'color:' + THEME.text,
                           'padding:11px 13px',
                           'border-radius:9px',
                           'font:' + (IS_MOBILE ? 16 : 15) + 'px -apple-system, sans-serif',
                           'outline:none',
                           'touch-action:manipulation',
                           '-webkit-text-size-adjust:100%',
                           'text-size-adjust:100%'
            ].join(';'));
            inp.type = type || 'text';
            inp.dataset.key = key;
            if (placeholder) inp.placeholder = placeholder;
            wrap.appendChild(lbl);
            wrap.appendChild(inp);
            return wrap;
        }

        p.appendChild(field('Server URL', 'wsUrl', 'text', 'wss://tuo-server.example.com/wt'));
        p.appendChild(field('Nome stanza', 'room', 'text', 'salotto'));
        p.appendChild(field('Password stanza', 'pass', 'password', ''));
        p.appendChild(field('Il tuo nome', 'author', 'text', 'Anon'));

        const btnRow = el('div', 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px');

        const saveBtn = el('button', [
            'flex:1', 'background:' + THEME.accent, 'color:#fff', 'border:0',
            'padding:12px', 'border-radius:10px', 'cursor:pointer',
            'font:600 14px -apple-system, sans-serif',
            '-webkit-tap-highlight-color:transparent', 'min-width:120px'
        ].join(';'), 'Salva e riconnetti');
        onTap(saveBtn, () => {
            const values = {};
            p.querySelectorAll('input[data-key]').forEach(i => values[i.dataset.key] = i.value.trim());
            if (!values.wsUrl || !values.room || !values.author) {
                alert('Server URL, stanza e nome sono obbligatori.');
                return;
            }
            wsUrl  = values.wsUrl;
            room   = values.room.slice(0, 64);
            pass   = values.pass.slice(0, 64);
            author = values.author.slice(0, 32);
            saveConfig();
            location.reload();
        });

        const changeRoomBtn = el('button', [
            'background:rgba(255,255,255,.06)', 'color:' + THEME.text,
                                 'border:1px solid ' + THEME.border,
                                 'padding:12px 14px', 'border-radius:10px', 'cursor:pointer',
                                 'font:500 14px -apple-system, sans-serif',
                                 '-webkit-tap-highlight-color:transparent'
        ].join(';'), 'Cambia stanza');
        onTap(changeRoomBtn, () => {
            closeOptions();
            localStorage.removeItem(LS.room);
            localStorage.removeItem(LS.pass);
            room = null;
            pass = '';
            try { ws && ws.close(); } catch (_) {}
            openRoomPicker();
        });

        const cancelBtn = el('button', [
            'background:rgba(255,255,255,.06)', 'color:' + THEME.text,
                             'border:1px solid ' + THEME.border,
                             'padding:12px 14px', 'border-radius:10px', 'cursor:pointer',
                             'font:500 14px -apple-system, sans-serif',
                             '-webkit-tap-highlight-color:transparent'
        ].join(';'), 'Annulla');
        onTap(cancelBtn, closeOptions);

        btnRow.appendChild(saveBtn);
        btnRow.appendChild(changeRoomBtn);
        btnRow.appendChild(cancelBtn);
        p.appendChild(btnRow);

        return p;
    }

    // =================================================================
    let pickerSocket = null;

    function openRoomPicker() {
        closeRoomPicker();
        setStatus('connecting', 'Scegli stanza');
        pickerSocket = new WebSocket(wsUrl);
        pickerSocket.onopen = () => {
            try { pickerSocket.send(JSON.stringify({ type: 'list-rooms' })); }
            catch (e) { log('picker send fail', e); }
        };
        pickerSocket.onmessage = (e) => {
            let m; try { m = JSON.parse(e.data); } catch (_) { return; }
            if (m.type === 'rooms') showRoomPicker(m.rooms || []);
        };
            pickerSocket.onerror = (e) => { log('picker WS error', e); };
    }

    function closeRoomPicker() {
        if (roomPickerEl && roomPickerEl.parentNode) roomPickerEl.parentNode.removeChild(roomPickerEl);
        roomPickerEl = null;
        if (pickerSocket) {
            try { pickerSocket.close(); } catch (_) {}
            pickerSocket = null;
        }
    }

    function showRoomPicker(rooms) {
        closeRoomPicker();
        roomPickerEl = el('div', [
            'position:fixed', 'inset:0',
            'background:rgba(0,0,0,.75)',
                          'z-index:2147483647',
                          'display:flex',
                          'align-items:' + (IS_MOBILE ? 'flex-end' : 'center'),
                          'justify-content:center',
                          'padding:' + (IS_MOBILE ? '0' : '20px')
        ].join(';'));

        const card = el('div', [
            'background:' + THEME.bgSoft,
            'border:1px solid ' + THEME.border,
            'color:' + THEME.text,
            'border-radius:' + (IS_MOBILE ? '20px 20px 0 0' : '16px'),
                        'width:100%',
                        'max-width:' + (IS_MOBILE ? '100%' : '460px'),
                        'max-height:' + (IS_MOBILE ? '85dvh' : '80vh'),
                        'display:flex', 'flex-direction:column',
                        'overflow:hidden',
                        'font:14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        'box-shadow:0 20px 60px rgba(0,0,0,.7)',
                        'padding-bottom:' + (IS_MOBILE ? 'env(safe-area-inset-bottom, 0px)' : '0')
        ].join(';'));

        const h = el('div', [
            'padding:16px 18px 10px',
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'flex-shrink:0'
        ].join(';'));
        const hTitle = el('div', 'font-weight:600;font-size:16px;display:flex;align-items:center;gap:8px');
        hTitle.appendChild(el('span', 'font-size:18px;', '🎬'));
        hTitle.appendChild(el('span', '', 'Watch Together'));
        h.appendChild(hTitle);
        if (room) {
            const cancelX = el('button', [
                'background:transparent', 'border:0', 'color:' + THEME.textMuted,
                'width:34px', 'height:34px', 'border-radius:8px', 'cursor:pointer',
                'font-size:22px', 'padding:0',
                'display:flex', 'align-items:center', 'justify-content:center',
                '-webkit-tap-highlight-color:transparent'
            ].join(';'), '×');
            onTap(cancelX, () => { closeRoomPicker(); if (room && author) connect(); });
            h.appendChild(cancelX);
        }
        card.appendChild(h);

        const body = el('div', [
            'flex:1', 'overflow-y:auto', 'padding:0 18px 18px',
            '-webkit-overflow-scrolling:touch'
        ].join(';'));

        if (rooms.length > 0) {
            body.appendChild(el('div', [
                'color:' + THEME.textMuted,
                'font-size:11px', 'font-weight:600',
                'text-transform:uppercase', 'letter-spacing:.6px',
                'margin:6px 0 8px'
            ].join(';'), 'Stanze disponibili'));

            const list = el('div', 'display:flex;flex-direction:column;gap:6px;margin-bottom:16px');
            rooms.forEach(r => {
                const ownToken = getOwnerToken(r.name);
                const row = el('div', [
                    'padding:12px 14px',
                    'border:1px solid ' + THEME.border,
                    'border-radius:10px',
                    'background:rgba(255,255,255,.03)',
                               'display:flex', 'align-items:center', 'gap:10px',
                               'cursor:pointer',
                               '-webkit-tap-highlight-color:transparent'
                ].join(';'));
                row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,.07)'; });
                row.addEventListener('mouseleave', () => { row.style.background = 'rgba(255,255,255,.03)'; });

                const dot = el('span', [
                    'display:inline-block',
                    'width:10px', 'height:10px',
                    'min-width:10px', 'min-height:10px',
                    'border-radius:50%',
                    'background:' + (r.clients > 0 ? THEME.ok : '#6b7280'),
                               'flex-shrink:0', 'box-sizing:border-box'
                ].join(';'));
                row.appendChild(dot);

                const info = el('div', 'flex:1;min-width:0');
                info.appendChild(el('div', 'font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', r.name));
                const metaText = (r.clients === 0 ? 'nessuno connesso' :
                r.clients === 1 ? '1 utente connesso' :
                r.clients + ' utenti connessi');
                info.appendChild(el('div', 'font-size:11px;color:' + THEME.textMuted + ';margin-top:2px', metaText));
                if (r.url) {
                    const currentVideo = extractVideoUrl(normalizeUrl(pageUrl));
                    const isSamePage = currentVideo && currentVideo === r.url;
                    info.appendChild(el('div', [
                        'font-size:10.5px', 'margin-top:2px',
                        'color:' + (isSamePage ? THEME.textMuted : THEME.link),
                                        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
                    ].join(';'), (isSamePage ? '' : '↗ ') + shortUrl(r.url, 45)));
                }
                row.appendChild(info);

                if (ownToken) row.appendChild(el('span', 'font-size:14px;flex-shrink:0;', '👑'));
                if (r.hasPassword) row.appendChild(el('span', 'font-size:14px;flex-shrink:0;color:' + THEME.gold + ';', '🔒'));
                row.appendChild(el('span', 'color:' + THEME.textMuted + ';font-size:18px;flex-shrink:0;', '›'));

                onTap(row, () => pickRoom(r.name, r.hasPassword, r.url));
                list.appendChild(row);
            });
            body.appendChild(list);

            body.appendChild(el('div', [
                'color:' + THEME.textMuted,
                'font-size:11px', 'font-weight:600',
                'text-transform:uppercase', 'letter-spacing:.6px',
                'margin:6px 0 8px'
            ].join(';'), 'Oppure crea una nuova stanza'));
        } else {
            body.appendChild(el('div', [
                'color:' + THEME.textMuted,
                'font-size:13px',
                'padding:8px 0 14px',
                'text-align:center'
            ].join(';'), 'Nessuna stanza attiva. Creane una nuova:'));
        }

        const createBox = el('div', [
            'padding:14px',
            'border:1px solid ' + THEME.border,
            'border-radius:10px',
            'background:rgba(34,197,94,.05)'
        ].join(';'));

        const nameLabel = el('div', 'color:' + THEME.textMuted + ';font-size:11px;font-weight:600;' +
        'text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px', 'Nome stanza');
        const nameInput = el('input', [
            'width:100%', 'box-sizing:border-box',
            'background:rgba(255,255,255,.06)',
                             'border:1px solid ' + THEME.border,
                             'color:' + THEME.text,
                             'padding:11px 13px',
                             'border-radius:9px',
                             'font:' + (IS_MOBILE ? 16 : 15) + 'px -apple-system, sans-serif',
                             'outline:none',
                             'touch-action:manipulation',
                             '-webkit-text-size-adjust:100%',
                             'text-size-adjust:100%',
                             'margin-bottom:10px'
        ].join(';'));
        nameInput.type = 'text';
        nameInput.placeholder = 'es. salotto';
        nameInput.maxLength = 64;

        const passLabel = el('div', 'color:' + THEME.textMuted + ';font-size:11px;font-weight:600;' +
        'text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px', 'Password (opzionale)');
        const passInput = el('input', [
            'width:100%', 'box-sizing:border-box',
            'background:rgba(255,255,255,.06)',
                             'border:1px solid ' + THEME.border,
                             'color:' + THEME.text,
                             'padding:11px 13px',
                             'border-radius:9px',
                             'font:' + (IS_MOBILE ? 16 : 15) + 'px -apple-system, sans-serif',
                             'outline:none',
                             'touch-action:manipulation',
                             '-webkit-text-size-adjust:100%',
                             'text-size-adjust:100%',
                             'margin-bottom:12px'
        ].join(';'));
        passInput.type = 'password';
        passInput.placeholder = 'lascia vuoto per nessuna password';
        passInput.maxLength = 64;

        const createBtn = el('button', [
            'width:100%',
            'background:' + THEME.accent, 'color:#fff', 'border:0',
            'padding:12px', 'border-radius:10px', 'cursor:pointer',
            'font:600 14px -apple-system, sans-serif',
            '-webkit-tap-highlight-color:transparent'
        ].join(';'), 'Crea e connetti');
        onTap(createBtn, () => {
            const n = nameInput.value.trim();
            if (!n || n.length > 64) {
                alert('Inserisci un nome valido (max 64 caratteri).');
                return;
            }
            createRoom(n, passInput.value || '');
        });

        createBox.appendChild(nameLabel);
        createBox.appendChild(nameInput);
        createBox.appendChild(passLabel);
        createBox.appendChild(passInput);
        createBox.appendChild(createBtn);
        body.appendChild(createBox);

        card.appendChild(body);
        roomPickerEl.appendChild(card);
        document.body.appendChild(roomPickerEl);
    }

    function pickRoom(name, hasPassword, roomUrl) {
        const targetUrl = roomUrl || '';
        const currentVideo = extractVideoUrl(normalizeUrl(pageUrl));
        const needsNavigation = targetUrl && targetUrl !== currentVideo;

        let p = '';
        if (hasPassword) {
            const entered = prompt('Password per la stanza "' + name + '":', '');
            if (entered === null) return;
            p = (entered || '').slice(0, 64);
        }

        if (needsNavigation) {
            const go = confirm(
                'La stanza "' + name + '" è su un altro video:\n\n' +
                shortUrl(targetUrl, 60) + '\n\n' +
                'Vuoi andare lì e unirti?'
            );
            if (!go) return;
            navigateTop(buildJoinUrl(targetUrl, name, p));
            return;
        }

        room = name;
        pass = p;
        autoReconnect = false;
        persistent = false;
        saveConfig();
        closeRoomPicker();
        if (!author) askAuthor(() => connect());
        else connect();
    }

    function createRoom(name, p) {
        room = name;
        autoReconnect = false;
        persistent = false;
        pass = p || '';
        saveConfig();
        closeRoomPicker();
        if (!author) askAuthor(() => connect());
        else connect();
    }

    // =================================================================
    function openSheet() {
        sheetOpen = true;
        closeOptions();
        sheet.style.display = 'flex';
        requestAnimationFrame(() => {
            if (IS_MOBILE) sheet.style.transform = 'translateY(0)';
            else { sheet.style.transform = 'translateY(0) scale(1)'; sheet.style.opacity = '1'; }
        });
        unread = 0;
        updateUnread();
        if (!IS_MOBILE) setTimeout(() => sheetInput.focus(), 300);
    }

    function closeSheet() {
        if (!sheetOpen) return;
        sheetOpen = false;
        if (IS_MOBILE) sheet.style.transform = 'translateY(100%)';
        else sheet.style.transform = 'translateY(-8px) scale(.98)';
        setTimeout(() => { sheet.style.display = 'none'; }, 250);
        if (document.activeElement === sheetInput) sheetInput.blur();
    }

    function openOptions() {
        optionsOpen = true;
        closeSheet();
        optionsPanel.querySelectorAll('input[data-key]').forEach(inp => {
            const k = inp.dataset.key;
            inp.value = k === 'wsUrl'  ? wsUrl  :
            k === 'room'   ? (room || '') :
            k === 'pass'   ? (pass || '') :
            k === 'author' ? (author || '') : '';
        });
        const box = document.getElementById('__wt_owner_box__');
        if (box) box.style.display = (isOwner && connected) ? 'block' : 'none';
        optionsPanel.style.display = 'flex';
        requestAnimationFrame(() => {
            if (IS_MOBILE) optionsPanel.style.transform = 'translateY(0)';
        });
    }

    function closeOptions() {
        if (!optionsOpen) return;
        optionsOpen = false;
        if (IS_MOBILE) optionsPanel.style.transform = 'translateY(100%)';
        setTimeout(() => { optionsPanel.style.display = 'none'; }, 250);
    }

    // =================================================================
    function setStatus(state, text) {
        if (!badgeDot) return;
        const colors = { connected: THEME.ok, connecting: THEME.warn, error: THEME.danger, disconnected: '#6b7280' };
        const glows = {
            connected: 'rgba(34,197,94,.6)',
 connecting: 'rgba(245,158,11,.6)',
 error: 'rgba(239,68,68,.6)',
 disconnected: 'rgba(107,114,128,.4)'
        };
        const c = colors[state] || THEME.warn;
        const g = glows[state] || glows.connecting;
        badgeDot.style.background = c;
        badgeDot.style.boxShadow = '0 0 0 3px ' + hexA(c, .28) + ', 0 0 10px ' + g;
        badgeLabel.textContent = text;
        const headerDot = document.getElementById('__wt_header_dot__');
        if (headerDot) {
            headerDot.style.background = c;
            headerDot.style.boxShadow = '0 0 0 3px ' + hexA(c, .28);
        }
        const headerTitle = document.getElementById('__wt_header_title__');
        if (headerTitle && room) headerTitle.textContent = 'Chat · ' + room;
    }

    function hexA(hex, a) {
        const r = parseInt(hex.slice(1,3),16);
        const g = parseInt(hex.slice(3,5),16);
        const b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${a})`;
    }

    function updateUnread() {
        if (unread > 0 && !sheetOpen) {
            badgeUnread.style.display = 'inline-block';
            badgeUnread.textContent = unread > 99 ? '99+' : String(unread);
        } else {
            badgeUnread.style.display = 'none';
        }
    }

    // =================================================================
    function _avatarColor(name) {
        let h = 0;
        const s = String(name || '?');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h) % 360;
    }
    function _initials(name) {
        const c = String(name || '?').trim();
        if (!c) return '?';
        const p = c.split(/[\s_-]+/).filter(Boolean);
        if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
        return c.slice(0, 2).toUpperCase();
    }

    function addChatLine(authorName, text, isOwn) {
        const row = el('div', [
            'display:flex', 'gap:9px',
            isOwn ? 'flex-direction:row-reverse' : 'flex-direction:row',
            'align-items:flex-end', 'width:100%',
            'animation:wt-slide-in .25s cubic-bezier(.2,.9,.3,1.3)',
            'margin-bottom:2px'
        ].join(';'));

        // Avatar con iniziali + colore deterministico
        const hue = _avatarColor(authorName);
        const av = el('div', [
            'flex-shrink:0',
            'width:30px', 'height:30px',
            'min-width:30px', 'min-height:30px',
            'border-radius:50%',
            'background:linear-gradient(135deg, hsl(' + hue + ',70%,62%), hsl(' + ((hue+40)%360) + ',75%,55%))',
            'color:#0a0a10',
            'font:800 12px -apple-system,sans-serif',
            'display:flex', 'align-items:center', 'justify-content:center',
            'box-shadow:0 3px 8px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.28)',
            'letter-spacing:-.3px',
            'transition:transform .15s ease'
        ].join(';'), _initials(isOwn ? (author || 'Tu') : authorName));
        if (isOwn) av.style.opacity = '0.55';
        row.appendChild(av);

        const col = el('div', [
            'display:flex', 'flex-direction:column',
            isOwn ? 'align-items:flex-end' : 'align-items:flex-start',
            'max-width:80%', 'min-width:0'
        ].join(';'));

        if (!isOwn) {
            const nm = el('div', [
                'font-size:11px', 'font-weight:700',
                'color:hsl(' + hue + ',70%,68%)',
                'margin:0 6px 3px',
                'letter-spacing:.2px'
            ].join(';'), authorName);
            col.appendChild(nm);
        }

        const bubble = el('div', [
            'padding:9px 13px',
            'border-radius:16px',
            isOwn ? 'border-bottom-right-radius:5px' : 'border-bottom-left-radius:5px',
            'background:' + (isOwn ? THEME.ownBubble : THEME.otherBubble),
            'border:1px solid ' + (isOwn ? hexA(THEME.accent, .35) : THEME.border),
            'color:' + THEME.text,
            'font-size:14px', 'line-height:1.45',
            'word-wrap:break-word', 'word-break:break-word',
            'transition:transform .12s ease, box-shadow .15s ease',
            'backdrop-filter:blur(6px)',
            '-webkit-backdrop-filter:blur(6px)'
        ].join(';'), text);
        bubble.addEventListener('mouseenter', () => {
            bubble.style.transform = 'translateY(-1px)';
            bubble.style.boxShadow = '0 6px 16px rgba(0,0,0,.3)';
        });
        bubble.addEventListener('mouseleave', () => {
            bubble.style.transform = '';
            bubble.style.boxShadow = '';
        });
        col.appendChild(bubble);

        const ts = el('div', [
            'font-size:9.5px', 'color:' + THEME.textMuted,
            'margin:2px 6px 4px', 'opacity:.75'
        ].join(';'), new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        col.appendChild(ts);

        row.appendChild(col);
        sheetList.appendChild(row);
        sheetList.scrollTop = sheetList.scrollHeight;
        if (!isOwn && !sheetOpen) { unread++; updateUnread(); }
    }

    function addSystemLine(text) {
        const row = el('div', [
            'display:flex', 'justify-content:center', 'width:100%',
            'margin:2px 0', 'animation:wt-slide-in .2s ease'
        ].join(';'));

        const pill = el('div', [
            'font-size:11px', 'color:' + THEME.textMuted,
            'background:rgba(255,255,255,.04)',
                        'border:1px solid ' + THEME.border,
                        'padding:4px 12px', 'border-radius:12px',
                        'font-style:italic',
                        'max-width:85%', 'text-align:center',
                        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
        ].join(';'), text);

        row.appendChild(pill);
        sheetList.appendChild(row);
        sheetList.scrollTop = sheetList.scrollHeight;
        if (!sheetOpen) { unread++; updateUnread(); }
    }

    function sendChat() {
        const text = sheetInput.value.trim();
        if (!text || !connected) return;
        send({ type: 'chat', author: author, text: text, clientId: clientId });
        sheetInput.value = '';
    }

    // =================================================================
    function askAuthor(cb) {
        const a = prompt('Il tuo nome (per la chat):', DEFAULTS.author);
        author = (a || DEFAULTS.author).trim().slice(0, 32);
        saveConfig();
        if (cb) cb();
    }

    // =================================================================
    function connect() {
        // chiudi eventuale socket precedente senza innescare riconnessione
        if (ws) {
            try {
                ws.onclose = null; ws.onerror = null;
                ws.onmessage = null; ws.onopen = null;
                ws.close();
            } catch (_) {}
            ws = null;
        }
        authFailed = false;
        setStatus('connecting', 'Connessione…');
        var __wt_meta = extractVideoMeta();
        var __wt_image = extractRoomImage();
        const canonical = normalizeUrl(pageUrl);
        const videoUrl = extractVideoUrl(canonical);
        log('connect: room=' + room + ' autoReconnect=' + autoReconnect + ' create=' + (!autoReconnect));
        log('connessione a', wsUrl, 'stanza:', room, 'url:', videoUrl);

        if (!videoUrl) {
            setStatus('error', 'URL video non trovato');
            return;
        }

        try { ws = new WebSocket(wsUrl); }
        catch (e) { log('new WebSocket fail', e); setStatus('error', 'URL non valido'); return; }

        ws.onopen = () => {
            reconnectDelay = RECONNECT_MIN;
            const navigating = pendingNavigateFlag;
            pendingNavigateFlag = false;
            try {
                ws.send(JSON.stringify({
                    type: 'hello',
                    room, pass, author,
                    persistent: persistent,
                    create: !autoReconnect,
                    ownerToken: getOwnerToken(room),
                    url: videoUrl,
                    title: __wt_meta.title,
                    description: __wt_meta.description,
                    image: __wt_image,
                    navigating: navigating,
                }));
            } catch (e) { log('send hello fail', e); }
        };

        ws.onclose = (ev) => {
            connected = false;
            isOwner = false;
            stopTicker();
            if (authFailed) return;
            const wait = reconnectDelay;
            setStatus('disconnected', room + ' · retry ' + Math.round(wait/1000) + 's');
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
            setTimeout(connect, wait);
        };

        ws.onerror = (e) => { log('errore WS', e); };

        ws.onmessage = (e) => {
            let m; try { m = JSON.parse(e.data); } catch (_) { return; }
            if (m.type === 'error') { handleError(m); return; }

            if (m.type === 'welcome') {
                connected = true;
                isOwner = !!m.isOwner;
                if (m.ownerToken) {
                    ownerToken = m.ownerToken;
                    setOwnerToken(room, m.ownerToken);
                } else {
                    ownerToken = '';
                    setOwnerToken(room, null);
                }
                setStatus('connected', room + (isOwner ? ' 👑' : ''));
                log('welcome, isOwner:', isOwner, 'url:', m.url);
                try {
                    ws.send(JSON.stringify({ type: 'sync-request', room, pass }));
                } catch (_) {}

                (function () {
                    var done = false;
                    var handler = function (ev) {
                        if (!ev.data || !ev.data.__wt_ep_result__) return;
                        if (done) return;
                        done = true;
                        try { window.removeEventListener('message', handler); } catch (_) {}
                        var candidate = ev.data.__wt_ep_result__ || '';
                        if (!candidate) return;
                        var known = m.url || '';
                        if (candidate === known) return;
                        try {
                            var kn = new URL(known, location.origin);
                            var ca = new URL(candidate, location.origin);
                            if (kn.pathname === ca.pathname &&
                                kn.searchParams.get('e') === ca.searchParams.get('e')) {
                                return;
                            }
                        } catch (_) {}
                        log('sync via parent:', known, '->', candidate);
                        try {
                            ws.send(JSON.stringify({
                                type: 'update-url',
                                room: room,
                                pass: pass,
                                url: candidate,
                            }));
                        } catch (_) {}
                    };
                    window.addEventListener('message', handler);
                    try { window.parent.postMessage({ __wt_ask_ep__: true }, '*'); } catch (_) {}
                    setTimeout(function () {
                        if (done) return;
                        done = true;
                        try { window.removeEventListener('message', handler); } catch (_) {}
                    }, 3000);
                })();

                (function () {
                    try {
                        var m2 = location.href.match(/\/it\/iframe\/(\d+)[^?]*\?[^#]*episode_id=(\d+)/);
                        if (!m2) return;
                        var showId = m2[1];
                        var epId   = m2[2];
                        var candidate = location.origin + '/it/watch/' + showId + '?e=' + epId;
                        var known = m.url || '';
                        if (candidate === known) return;
                        try {
                            var kn = new URL(known);
                            var ca = new URL(candidate);
                            if (kn.pathname === ca.pathname &&
                                kn.searchParams.get('e') === ca.searchParams.get('e')) {
                                return;
                            }
                        } catch (_) {}
                        log('sync automatico cambio episodio:', known, '->', candidate);
                        ws.send(JSON.stringify({
                            type: 'update-url',
                            room: room,
                            pass: pass,
                            url: candidate,
                        }));
                    } catch (_) {}
                })();
                return;
            }
            if (m.type === 'navigate') {
                if (!m.url) return;
                const current = extractVideoUrl(
                    normalizeUrl(pageUrl || location.href)
                );
                if (m.url === current) {
                    log('navigate ignorato (gia su questo URL)');
                    return;
                }
                log('navigate ricevuto, seguo:', m.url);
                try {
                    sessionStorage.setItem('wt_following_navigate', '1');
                    sessionStorage.removeItem('wt_pending_navigate');
                } catch (_) {}
                // Naviga il TOP (il video sta li'), non l'iframe vixcloud.
                // Includi la stanza nell'hash cosi' al reload l'iframe si
                // riconnette da solo (no picker, no re-login).
                const joinUrl = buildJoinUrl(m.url, room, pass);
                setTimeout(function () { navigateTop(joinUrl); }, 150);
                return;
            }
            if (m.type === 'persistent-created') {
            // Non gestito dal client iframe (solo homepage)
            log('persistent-created ricevuto (ignorato nel client)');
            return;
        }
        if (m.type === 'room-deleted') {
            alert('Questa stanza è stata cancellata dal proprietario.');
            try { ws.close(); } catch (_) {}
            room = null;
            pass = '';
            localStorage.removeItem(LS.room);
            localStorage.removeItem(LS.pass);
            setTimeout(() => openRoomPicker(), 100);
            return;
        }
        if (m.type === 'room-updated') {
            log('room aggiornata:', m.url);
            if (m.hasPassword === false) pass = '';
            return;
        }
        if (m.type === 'password-changed') {
                alert('Password stanza ' + (m.hasPassword ? 'aggiornata' : 'rimossa') + '.');
                return;
            }
            handle(m);
        };
    }

    function navigateTop(url) {
        if (!url) return;
        if (IS_TOP) {
            try { window.location.href = url; } catch (_) {}
            return;
        }
        // 1) same-origin: accesso diretto alla top
        try {
            if (window.top !== window) {
                window.top.location.href = url;
                return;
            }
        } catch (_) {}
        // 2) cross-origin: anchor target=_top
        try {
            const a = document.createElement('a');
            a.href = url;
            a.target = '_top';
            a.rel = 'noopener';
            a.style.display = 'none';
            (document.body || document.documentElement).appendChild(a);
            a.click();
            setTimeout(function(){ try { a.remove(); } catch(_){} }, 200);
            return;
        } catch (_) {}
        // 3) ultimo tentativo
        try { window.location.href = url; } catch (_) {}
    }

    function buildJoinUrl(baseUrl, roomName, roomPass) {
        if (!baseUrl || !roomName) return '';
        const cleanBase = String(baseUrl).split('#')[0];
        const params = [];
        params.push('wt_room=' + encodeURIComponent(roomName));
        if (roomPass) params.push('wt_pass=' + encodeURIComponent(roomPass));
        if (author)    params.push('wt_author=' + encodeURIComponent(author));
        const ot = getOwnerToken(roomName);
        if (ot) params.push('wt_owner=' + encodeURIComponent(ot));
        return cleanBase + '#' + params.join('&');
    }

    function handleError(m) {
        if (m.code === 'auth') {
            authFailed = true;
            setStatus('error', 'Password errata');
            try { ws.close(); } catch (_) {}
            setTimeout(() => {
                alert((m.message || 'Password errata.') + '\n\nScegli di nuovo la stanza.');
                room = null;
                localStorage.removeItem(LS.room);
                localStorage.removeItem(LS.pass);
                openRoomPicker();
            }, 100);
            return;
        }
        if (m.code === 'no_such_room') {
            // Stanza cancellata dal server: non ricrearla, mostra il picker
            authFailed = true;
            try { ws.close(); } catch (_) {}
            log('stanza inesistente, apro il picker');
            room = null;
            pass = '';
            localStorage.removeItem(LS.room);
            localStorage.removeItem(LS.pass);
            autoReconnect = false;
            setTimeout(() => openRoomPicker(), 100);
            return;
        }
        if (m.code === 'no_url') {
            authFailed = true;
            setStatus('error', 'URL video non valido');
            try { ws.close(); } catch (_) {}
            setTimeout(() => {
                alert('URL del video non risolto. Ricarica la pagina.');
                room = null;
                localStorage.removeItem(LS.room);
                localStorage.removeItem(LS.pass);
            }, 100);
            return;
        }
        if (m.code === 'wrong_url') {
            authFailed = true;
            setStatus('error', 'Video diverso');
            try { ws.close(); } catch (_) {}
            const correct = m.correctUrl || '';
            setTimeout(() => {
                const go = confirm(
                    'Questa stanza è legata a un altro video:\n\n' +
                    shortUrl(correct, 60) + '\n\n' +
                    'Vuoi andare lì e unirti?'
                );
                if (go && correct) {
                    navigateTop(buildJoinUrl(correct, room, pass));
                } else {
                    room = null;
                    localStorage.removeItem(LS.room);
                    localStorage.removeItem(LS.pass);
                    openRoomPicker();
                }
            }, 100);
            return;
        }
        setStatus('error', m.message || 'Errore');
        alert(m.message || 'Errore');
    }

    function send(o) {
        if (!connected || ws.readyState !== 1) { log('send: socket non pronto', o.type); return; }
        if (lock && (o.type === 'play' || o.type === 'pause' || o.type === 'seek' || o.type === 'tick')) {
            return;
        }
        o.room = room;
        o.pass = pass;
        try { ws.send(JSON.stringify(o)); }
        catch (e) { log('send fail', e); connected = false; try { ws.close(); } catch (_) {} }
    }

    // =================================================================
    function startTicker() {
        stopTicker();
        const jitter = Math.random() * 3000;
        tickTimer = setInterval(() => {
            if (!connected || video.paused || lock) return;
            send({ type: 'tick', t: video.currentTime });
        }, TICK_INTERVAL + jitter);
    }
    function stopTicker() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    // =================================================================
    //                  AUTOPLAY CON GESTO UTENTE
    // =================================================================
    function tryPlayVideo() {
    if (!video) return;
    if (!video.paused) {
      setStatus('connected', room + (isOwner ? ' \u{1F451}' : ''));
      return;
    }
    const wasMuted = video.muted;
    // 1) Tentativo con audio
    const p = video.play();
    if (!p || typeof p.then !== 'function') return;
    p.then(() => {
      setStatus('connected', room + (isOwner ? ' \u{1F451}' : ''));
    }).catch(() => {
      // 2) Forza muted (autoplay policy)
      video.muted = true;
      const p2 = video.play();
      if (!p2 || typeof p2.then !== 'function') return;
      p2.then(() => {
        if (wasMuted) return;
        // 3) Prova unmute dopo 200ms (funziona se il browser ha gesture)
        setTimeout(() => {
          video.muted = false;
          const p3 = video.play();
          if (p3 && typeof p3.then === 'function') {
            p3.catch(() => {
              video.muted = true;
              setStatus('connected', '\u{1F507} Tocca per audio');
              armUnmuteOnGesture();
            });
          }
        }, 200);
      }).catch(() => {
        // 4) Anche muto fallisce: pulsante "Tocca per avviare"
        video.muted = wasMuted;
        pendingPlayTarget = video.currentTime;
        setStatus('connecting', '\u25B6 Tocca per avviare');
        showTapToStart();
      });
    });
  }

  function showTapToStart() {
    if (document.getElementById('__wt_tap_start__')) return;
    const btn = document.createElement('button');
    btn.id = '__wt_tap_start__';
    btn.textContent = '\u25B6 Tocca per sincronizzare';
    btn.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%',
      'transform:translate(-50%,-50%)',
      'z-index:2147483647',
      'background:linear-gradient(135deg,#22c55e,#16a34a)',
      'color:#fff', 'border:0',
      'padding:16px 28px', 'border-radius:999px',
      'font:700 15px -apple-system,sans-serif',
      'cursor:pointer',
      'box-shadow:0 10px 40px rgba(34,197,94,.55), 0 0 0 4px rgba(34,197,94,.2)',
      'animation:wt-pulse-btn 1.6s ease-in-out infinite',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    btn.onclick = () => {
      try { btn.remove(); } catch (_) {}
      try { video.muted = false; } catch (_) {}
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => setStatus('connected', room + (isOwner ? ' \u{1F451}' : '')))
         .catch(() => { try { video.muted = true; } catch(_){} video.play(); });
      }
    };
    document.body.appendChild(btn);
    // Rimuovilo automaticamente se il video parte
    const iv = setInterval(() => {
      if (!video || !video.paused) {
        try { btn.remove(); } catch (_) {}
        clearInterval(iv);
      }
    }, 500);
    setTimeout(() => { try { btn.remove(); } catch (_) {} clearInterval(iv); }, 15000);
  }

function armAutoPlayOnGesture() {
    if (autoplayArmed) return;
    autoplayArmed = true;
    log('autoplay armato (pointerup), attendo gesto');

    const onUp = (e) => {
      try {
        if (sheet && sheet.contains(e.target)) return;
        if (optionsPanel && optionsPanel.contains(e.target)) return;
        if (badge && badge.contains(e.target)) return;
      } catch (_) {}

      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown',   onUp);
      autoplayArmed = false;

      const target = pendingPlayTarget;
      setTimeout(() => {
        const p = video.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            if (target !== null && Math.abs(video.currentTime - target) > 0.5) {
              video.currentTime = target;
            }
            setStatus('connected', room + (isOwner ? ' \u{1F451}' : ''));
            log('autoplay riuscito al gesto');
          }).catch((err) => {
            log('autoplay ancora bloccato:', err && err.name);
          });
        }
      }, 40);
    };

    document.addEventListener('pointerup', onUp, { once: true, passive: true });
    document.addEventListener('keydown',   onUp, { once: true });
  }

  // Listener globale one-shot: al primissimo tocco, se il video è muto
  // e in play, togli il mute. Funziona in aggiunta a armUnmuteOnGesture.

  let unmuteArmed = false;

function armUnmuteOnGesture() {
    if (unmuteArmed) return;
    unmuteArmed = true;
    log('unmute armato (pointerup), attendo primo gesto');

    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      unmuteArmed = false;
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown',   onUp);
      log('unmute disarmato');
    };

    const onUp = () => {
      if (done) return;
      cleanup();
      // Aspetta 80ms che il player abbia processato il tap, poi togli il mute
      setTimeout(() => {
        if (video && !video.paused && video.muted) {
          video.muted = false;
          setStatus('connected', room + (isOwner ? ' \u{1F451}' : ''));
          log('audio sbloccato al gesto');
        }
      }, 80);
    };

    document.addEventListener('pointerup', onUp, { once: true, passive: true });
    document.addEventListener('keydown',   onUp, { once: true });
  }

    // =================================================================
    function handle(m) {
        if (!m || !m.type) return;

        if (m.type === 'chat') {
            const isOwn = (m.clientId && m.clientId === clientId)
            || (!m.clientId && m.author === author);
            addChatLine(m.author || '?', m.text || '', isOwn);
            return;
        }

        if (m.type === 'presence') {
            if (m.action === 'joined') {
                addSystemLine((m.author || '?') + ' è entrato in stanza');
                // Manda lo stato ATTUALE (play/pause + currentTime) al nuovo peer
                // 3 volte per sicurezza, così si posiziona al secondo corrente.
                if (connected && !lock) {
                    const snap = () => {
                        if (!connected || lock) return;
                        const k = video.paused ? 'pause' : 'play';
                        send({ type: k, t: video.currentTime });
                    };
                    setTimeout(snap, 100);
                    setTimeout(snap, 700);
                    setTimeout(snap, 1500);
                }
            } else if (m.action === 'left') {
                addSystemLine((m.author || '?') + ' è uscito dalla stanza');
            }
            return;
        }

        if (m.type === 'tick') {
            // Ignora i tick se siamo in pausa. Il peer che vuole farci
            // ripartire manderà un play esplicito, non un tick.
            if (video.paused) return;
            if (Math.abs(video.currentTime - m.t) > THRESHOLD_TICK) {
                lock = true;
                try { video.currentTime = m.t; }
                finally { setTimeout(() => { lock = false; }, 100); }
            }
            return;
        }

        lock = true;
        try {
            if (m.type === 'play') {
                if (Math.abs(video.currentTime - m.t) > THRESHOLD_PLAY) video.currentTime = m.t;
                tryPlayVideo();
            } else if (m.type === 'pause') {
                video.pause();
                if (Math.abs(video.currentTime - m.t) > THRESHOLD_PAUSE) video.currentTime = m.t;
            } else if (m.type === 'seek') {
                video.currentTime = m.t;
            }
        } finally {
            setTimeout(() => { lock = false; }, LOCK_MS);
        }
    }

    // =================================================================
    const styleTag = document.createElement('style');
    styleTag.textContent = `
    @keyframes wt-slide-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes wt-pulse-btn {
        0%,100% { transform:translate(-50%,-50%) scale(1); box-shadow:0 10px 40px rgba(34,197,94,.55), 0 0 0 4px rgba(34,197,94,.2); }
        50%     { transform:translate(-50%,-50%) scale(1.05); box-shadow:0 14px 50px rgba(34,197,94,.75), 0 0 0 10px rgba(34,197,94,.08); }
    }
    `;
    (document.head || document.documentElement).appendChild(styleTag);

    // =============================================================
    // POLLING URL: aggiorna la stanza quando cambia episodio (ogni 5s)
    // =============================================================
    var __wt_lastUrl = null;

    function __wt_askTopUrl() {
        if (IS_TOP) return Promise.resolve(location.href);
        return new Promise(function (resolve) {
            var done = false;
            var handler = function (e) {
                if (e.data && e.data[PARENT_RESP]) {
                    if (done) return;
                    done = true;
                    window.removeEventListener('message', handler);
                    resolve(e.data[PARENT_RESP]);
                }
            };
            window.addEventListener('message', handler);
            try { window.top.postMessage({ [PARENT_REQ]: true }, '*'); } catch (_) {}
            setTimeout(function () {
                if (done) return;
                done = true;
                window.removeEventListener('message', handler);
                resolve('');
            }, 800);
        });
    }

    setInterval(function () {
        if (!connected || !room || !ws || ws.readyState !== 1) return;
        __wt_askTopUrl().then(function (raw) {
            if (!raw) return;
            var v = extractVideoUrl(normalizeUrl(raw));
            if (!v) return;
            if (!__wt_lastUrl) {
                __wt_lastUrl = extractVideoUrl(normalizeUrl(pageUrl || '')) || v;
                return;
            }
            if (v === __wt_lastUrl) return;
            log('URL video cambiato:', __wt_lastUrl, '->', v);
            __wt_lastUrl = v;
            try {
                var meta = extractVideoMeta();
                ws.send(JSON.stringify({
                    type: 'update-url',
                    room: room,
                    pass: pass,
                    url: v,
                    title: meta.title,
                    description: meta.description,
                }));
                log('update-url inviato:', v);
            } catch (e) { log('update-url fail:', e); }
        }).catch(function () {});
    }, 5000);

    // Handler per messaggi 'url-updated' dal server
    // (gestito dentro ws.onmessage gia' esistente: se assente, log)

    // =========================================================
    // Poller che aggiorna titolo/descrizione della stanza quando
    // il DOM di StreamingCommunity li rende disponibili.
    // =========================================================
    setInterval(function () {
        if (!connected || !room || !ws || ws.readyState !== 1) return;
        var meta = extractVideoMeta();
        var img = extractRoomImage();
        if (!meta.title) return;
        if (meta.title === window.__wt_lastTitle) return;
        window.__wt_lastTitle = meta.title;
        try {
            ws.send(JSON.stringify({
                type: 'update-meta',
                room: room,
                pass: pass,
                title: meta.title,
                description: meta.description,
                image: img,
            }));
            log('update-meta inviato:', meta.title);
        } catch (_) {}
    }, 3000);

})();
