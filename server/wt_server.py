#!/usr/bin/env python3
"""
Watch Together — Server relay WebSocket (Python 3.10+).

Ottimizzazioni v4.1:
  • WS persistente per homepage (subscribe-rooms) invece di polling ogni 5s
  • sync-request compatto (1 frame invece di 50)
  • db_upsert preserva title/description/image
  • broadcast_room_list sui cambi stanza (join/leave/create/update/delete)
"""
import asyncio
import json
import logging
import os
import re
import secrets
import sqlite3
import time

import websockets


HOST             = os.getenv("WT_HOST", "127.0.0.1")
PORT             = int(os.getenv("WT_PORT", "8765"))
ROOM_IDLE_TTL    = int(os.getenv("WT_ROOM_TTL", "300"))
TOMBSTONE_TTL    = int(os.getenv("WT_TOMBSTONE_TTL", "300"))
DB_PATH          = os.getenv("WT_DB_PATH", "/opt/watch-together/rooms.db")
MAX_CHAT_HISTORY = 50
MAX_MESSAGE_SIZE = 1024
CHAT_RATE_SEC    = 1.0
CHAT_MAX_LEN     = 500
URL_MAX_LEN      = 500

VIDEO_URL_PATTERNS = [
    re.compile(r"/it/watch/\d+(?:\?[^\s]*)?",  re.IGNORECASE),
    re.compile(r"/watch/\d+(?:\?[^\s]*)?",     re.IGNORECASE),
    re.compile(r"/it/iframe/\d+(?:\?[^\s]*)?", re.IGNORECASE),
]
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)

ADMIN_USER = os.getenv("WT_ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("WT_ADMIN_PASS", "")
ADMIN_SESSION_TTL = 3600
ADMIN_SESSIONS = {}


def _is_admin(token):
    if not token:
        return False
    exp = ADMIN_SESSIONS.get(token)
    if not exp or exp < time.time():
        ADMIN_SESSIONS.pop(token, None)
        return False
    return True


def _prune_admin_sessions():
    now = time.time()
    for k in [k for k, v in ADMIN_SESSIONS.items() if v < now]:
        ADMIN_SESSIONS.pop(k, None)


logging.basicConfig(
    format="[WT] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("wt")

ROOMS: dict = {}
LISTENERS: set = set()
TOMBSTONES: dict = {}


def db_init():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS persistent_rooms (
            name        TEXT PRIMARY KEY,
            password    TEXT NOT NULL DEFAULT '',
            owner_token TEXT NOT NULL DEFAULT '',
            url         TEXT NOT NULL DEFAULT '',
            title       TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            image       TEXT NOT NULL DEFAULT '',
            created_at  REAL NOT NULL
        )
    """)
    for col in ("title", "description", "image"):
        try:
            conn.execute(f"ALTER TABLE persistent_rooms ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()


def db_load_all() -> dict:
    conn = sqlite3.connect(DB_PATH)
    rooms = {}
    for row in conn.execute(
        "SELECT name, password, owner_token, url, created_at, title, description, image FROM persistent_rooms"
    ):
        rooms[row[0]] = {
            "password": row[1],
            "owner_token": row[2],
            "url": row[3],
            "created_at": row[4],
            "title": row[5] if len(row) > 5 else "",
            "description": row[6] if len(row) > 6 else "",
            "image": row[7] if len(row) > 7 else "",
        }
    conn.close()
    return rooms


def db_upsert(name, password, owner_token, url, title=None, description=None, image=None):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT title, description, image FROM persistent_rooms WHERE name = ?",
        (name,),
    ).fetchone()
    if title is None:
        title = row[0] if row else ""
    if description is None:
        description = row[1] if row else ""
    if image is None:
        image = row[2] if row else ""
    conn.execute("""
        INSERT INTO persistent_rooms (name, password, owner_token, url, created_at, title, description, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            password    = excluded.password,
            owner_token = excluded.owner_token,
            url         = excluded.url,
            title       = excluded.title,
            description = excluded.description,
            image       = excluded.image
    """, (name, password, owner_token, url, time.time(), title, description, image))
    conn.commit()
    conn.close()


def db_delete(name):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM persistent_rooms WHERE name = ?", (name,))
    conn.commit()
    conn.close()


def sanitize_chat(text: str) -> str:
    text = (text or "").strip()[:CHAT_MAX_LEN]
    return URL_RE.sub("[link rimosso]", text)


def sanitize_url(url: str) -> str:
    if not url or not isinstance(url, str):
        return ""
    url = url.strip()[:URL_MAX_LEN]
    for pattern in VIDEO_URL_PATTERNS:
        if pattern.search(url):
            return url
    return ""


def client_ip(ws) -> str:
    try:
        a = ws.remote_address
        return a[0] if a else ""
    except Exception:
        return ""


def is_owner(r_obj: dict, owner_token: str) -> bool:
    if not owner_token:
        return False
    return owner_token == r_obj.get("owner_token", "")


def cancel_cleanup(r_obj: dict) -> None:
    task = r_obj.get("cleanup_task")
    if task and not task.done():
        task.cancel()
    r_obj["cleanup_task"] = None


def prune_tombstones():
    now = time.time()
    dead = [k for k, v in TOMBSTONES.items() if v["expires_at"] < now]
    for k in dead:
        TOMBSTONES.pop(k, None)


def _rooms_snapshot():
    rooms = [
        {
            "name": r_name,
            "clients": len(r_data["clients"]),
            "hasPassword": bool(r_data.get("password", "")),
            "url": r_data.get("url", ""),
            "title": r_data.get("title", ""),
            "description": r_data.get("description", ""),
            "image": r_data.get("image", ""),
            "persistent": bool(r_data.get("persistent", False)),
        }
        for r_name, r_data in ROOMS.items()
    ]
    rooms.sort(key=lambda x: (-x["clients"], x["name"]))
    return rooms[:50]


async def broadcast_room_list() -> None:
    """Push lista stanze aggiornata a tutti i listener della homepage."""
    if not LISTENERS:
        return
    payload = json.dumps({"type": "rooms", "rooms": _rooms_snapshot()})
    await asyncio.gather(
        *(w.send(payload) for w in tuple(LISTENERS)),
        return_exceptions=True,
    )


async def broadcast(room: str, payload: dict, skip=None) -> None:
    r = ROOMS.get(room)
    if not r:
        return
    peers = tuple(r["clients"])
    await asyncio.gather(
        *(p.send(json.dumps(payload)) for p in peers if p is not skip),
        return_exceptions=True,
    )


async def handler(ws):
    room = None
    last_chat_ts = 0.0
    my_ip = client_ip(ws)
    my_author = "?"
    title = ""
    description = ""
    image = ""

    try:
        async for raw in ws:
            if len(raw) > MAX_MESSAGE_SIZE:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            t = msg.get("type")

            if t == "list-rooms":
                prune_tombstones()
                try:
                    await ws.send(json.dumps({"type": "rooms", "rooms": _rooms_snapshot()}))
                except Exception:
                    pass
                continue

            if t == "subscribe-rooms":
                LISTENERS.add(ws)
                try:
                    await ws.send(json.dumps({"type": "rooms", "rooms": _rooms_snapshot()}))
                except Exception:
                    pass
                continue

            if t == "verify-password":
                name = msg.get("name") or ""
                pwd_check = msg.get("password") or ""
                r_obj = ROOMS.get(name)
                if r_obj is None:
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "no_such_room",
                            "message": "La stanza non esiste piu'",
                        }))
                    except Exception:
                        pass
                    continue
                stored = r_obj.get("password", "")
                if stored and stored != pwd_check:
                    log.info(f"verify-password FAIL per {name!r} da {client_ip(ws)}")
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "auth",
                            "message": "Password errata",
                        }))
                    except Exception:
                        pass
                    continue
                try:
                    await ws.send(json.dumps({
                        "type": "verify-password-ok",
                        "name": name,
                        "ownerToken": r_obj.get("owner_token", ""),
                    }))
                except Exception:
                    pass
                continue

            if t == "admin-login":
                u = (msg.get("username") or "").strip()
                pwd_in = msg.get("password") or ""
                if ADMIN_PASS and u == ADMIN_USER and secrets.compare_digest(pwd_in, ADMIN_PASS):
                    _prune_admin_sessions()
                    token = secrets.token_urlsafe(24)
                    ADMIN_SESSIONS[token] = time.time() + ADMIN_SESSION_TTL
                    log.info(f"admin login OK da {client_ip(ws)}")
                    try:
                        await ws.send(json.dumps({
                            "type": "admin-login-ok", "token": token,
                            "ttl": ADMIN_SESSION_TTL,
                        }))
                    except Exception:
                        pass
                else:
                    log.info(f"admin login FAIL da {client_ip(ws)} user={u!r}")
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "auth",
                            "message": "Credenziali errate",
                        }))
                    except Exception:
                        pass
                continue

            if t == "admin-delete-room":
                if not _is_admin(msg.get("token") or ""):
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "not_admin",
                            "message": "Sessione admin non valida",
                        }))
                    except Exception:
                        pass
                    continue
                name = msg.get("name") or ""
                r_obj = ROOMS.get(name)
                if not r_obj:
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "not_found",
                            "message": "Stanza inesistente",
                        }))
                    except Exception:
                        pass
                    continue
                db_delete(name)
                for peer in tuple(r_obj["clients"]):
                    try:
                        await peer.send(json.dumps({
                            "type": "room-deleted", "room": name,
                        }))
                    except Exception:
                        pass
                ROOMS.pop(name, None)
                await broadcast_room_list()
                log.info(f"admin ha cancellato la stanza {name!r}")
                try:
                    await ws.send(json.dumps({"type": "admin-ok"}))
                except Exception:
                    pass
                continue

            if t == "admin-update-room":
                if not _is_admin(msg.get("token") or ""):
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "not_admin",
                            "message": "Sessione admin non valida",
                        }))
                    except Exception:
                        pass
                    continue
                name = msg.get("name") or ""
                r_obj = ROOMS.get(name)
                if not r_obj:
                    try:
                        await ws.send(json.dumps({
                            "type": "error", "code": "not_found",
                            "message": "Stanza inesistente",
                        }))
                    except Exception:
                        pass
                    continue
                new_url = sanitize_url(msg.get("url") or "")
                if new_url:
                    r_obj["url"] = new_url
                if "image" in msg:
                    r_obj["image"] = (msg.get("image") or "").strip()[:300]
                if "password" in msg:
                    r_obj["password"] = (msg.get("password") or "")[:64]
                if "persistent" in msg:
                    r_obj["persistent"] = bool(msg.get("persistent"))
                if r_obj.get("persistent"):
                    db_upsert(
                        name,
                        r_obj.get("password", ""),
                        r_obj.get("owner_token", ""),
                        r_obj.get("url", ""),
                        title=r_obj.get("title", ""),
                        description=r_obj.get("description", ""),
                        image=r_obj.get("image", ""),
                    )
                else:
                    db_delete(name)
                await broadcast(name, {
                    "type": "room-updated",
                    "room": name,
                    "url": r_obj.get("url", ""),
                    "hasPassword": bool(r_obj.get("password", "")),
                    "persistent": bool(r_obj.get("persistent", False)),
                })
                await broadcast_room_list()
                log.info(f"admin ha aggiornato la stanza {name!r}")
                try:
                    await ws.send(json.dumps({"type": "admin-ok"}))
                except Exception:
                    pass
                continue

            if t == "hello":
                r = msg.get("room")
                if not r or not isinstance(r, str) or len(r) > 64:
                    continue

                p = msg.get("pass") or ""
                if not isinstance(p, str) or len(p) > 64:
                    p = ""

                ot = msg.get("ownerToken") or ""
                if not isinstance(ot, str) or len(ot) > 128:
                    ot = ""

                author = (msg.get("author") or "?").strip()[:32] or "?"
                url = sanitize_url(msg.get("url") or "")
                title = (msg.get("title") or "").strip()[:200]
                description = (msg.get("description") or "").strip()[:300]
                image = (msg.get("image") or "").strip()[:300]

                create = msg.get("create", True) is True
                persistent = msg.get("persistent", False) is True

                existing = ROOMS.get(r)

                if existing is None:
                    prune_tombstones()

                    tomb = TOMBSTONES.get(r)
                    if tomb:
                        if tomb["password"] != p:
                            log.info(
                                f"BLOCCATO re-create {r!r}: tombstone mismatch "
                                f"(expected={tomb['password']!r}, got={p!r}) da {my_ip}"
                            )
                            try:
                                await ws.send(json.dumps({
                                    "type": "error",
                                    "code": "auth",
                                    "message": "Password errata per la stanza",
                                }))
                            except Exception:
                                pass
                            await ws.close(code=4001, reason="auth failed")
                            return
                        log.info(f"re-create {r!r} autorizzato dal tombstone")

                    if not create:
                        try:
                            await ws.send(json.dumps({
                                "type": "error",
                                "code": "no_such_room",
                                "message": "La stanza non esiste piu'.",
                            }))
                        except Exception:
                            pass
                        await ws.close(code=4004, reason="no such room")
                        return

                    if not url:
                        try:
                            await ws.send(json.dumps({
                                "type": "error",
                                "code": "no_url",
                                "message": "URL video non valido.",
                            }))
                        except Exception:
                            pass
                        await ws.close(code=4003, reason="no url")
                        return

                    token = secrets.token_urlsafe(16)
                    ROOMS[r] = {
                        "title": title,
                        "description": description,
                        "image": image,
                        "clients": set(),
                        "authors": {},
                        "chat": [],
                        "state": None,
                        "password": p,
                        "owner_token": token,
                        "url": url,
                        "created_at": time.time(),
                        "cleanup_task": None,
                        "persistent": persistent,
                    }
                    if persistent:
                        db_upsert(r, p, token, url,
                                  title=title, description=description, image=image)
                    owner = True
                    out_token = token
                    log.info(f"stanza creata: {r!r} url={url!r} persistent={persistent} da {my_ip}")

                else:
                    existing_pwd = existing.get("password", "")
                    if existing_pwd and existing_pwd != p and not is_owner(existing, ot):
                        log.info(
                            f"password check FAILED per {r!r}: "
                            f"expected={existing_pwd!r}, got={p!r}, da {my_ip}"
                        )
                        try:
                            await ws.send(json.dumps({
                                "type": "error",
                                "code": "auth",
                                "message": "Password errata per la stanza",
                            }))
                        except Exception:
                            pass
                        await ws.close(code=4001, reason="auth failed")
                        return

                    existing_url = existing.get("url", "")
                    if title:
                        existing["title"] = title
                    if description:
                        existing["description"] = description
                    if image:
                        existing["image"] = image
                    owner_check = is_owner(existing, ot)
                    if existing_url and url and existing_url != url:
                        if owner_check or len(existing["clients"]) == 0:
                            existing["url"] = url
                            if existing.get("persistent"):
                                db_upsert(r, existing.get("password", ""),
                                          existing.get("owner_token", ""), url,
                                          title=existing.get("title", ""),
                                          description=existing.get("description", ""),
                                          image=existing.get("image", ""))
                            log.info(f"stanza {r!r} URL aggiornato a {url!r} (owner)")
                        else:
                            try:
                                await ws.send(json.dumps({
                                    "type": "error",
                                    "code": "wrong_url",
                                    "message": "Questa stanza e' legata a un altro video",
                                    "correctUrl": existing_url,
                                }))
                            except Exception:
                                pass
                            await ws.close(code=4002, reason="wrong url")
                            return
                    elif not existing_url and url:
                        existing["url"] = url
                        if existing.get("persistent"):
                            db_upsert(r, existing.get("password", ""),
                                      existing.get("owner_token", ""), url,
                                      title=existing.get("title", ""),
                                      description=existing.get("description", ""),
                                      image=existing.get("image", ""))

                    owner = is_owner(existing, ot)
                    out_token = existing.get("owner_token", "") if owner else None
                    cancel_cleanup(existing)

                was_in_room = (room == r)
                if room != r:
                    if room is not None:
                        await leave(room, ws)
                    room = r
                    join(room, ws)

                my_author = author
                ROOMS[room]["authors"][ws] = author

                try:
                    await ws.send(json.dumps({
                        "type": "welcome",
                        "room": r,
                        "url": ROOMS[r].get("url", ""),
                        "clients": len(ROOMS[r]["clients"]),
                        "isOwner": owner,
                        "hasPassword": bool(ROOMS[r].get("password", "")),
                        "ownerToken": out_token,
                        "persistent": bool(ROOMS[r].get("persistent", False)),
                    }))
                except Exception:
                    pass

                if not was_in_room:
                    await broadcast(room, {
                        "type": "presence",
                        "action": "joined",
                        "author": author,
                        "clients": len(ROOMS[room]["clients"]),
                    }, skip=ws)
                    await broadcast_room_list()
                continue

            if t == "set-password":
                if room is None or room not in ROOMS:
                    continue
                r_obj = ROOMS[room]
                ot = msg.get("ownerToken") or ""
                if not is_owner(r_obj, ot):
                    try:
                        await ws.send(json.dumps({
                            "type": "error",
                            "code": "not_owner",
                            "message": "Solo il creatore puo' cambiare la password",
                        }))
                    except Exception:
                        pass
                    continue
                new_pass = msg.get("newPass") or ""
                if not isinstance(new_pass, str) or len(new_pass) > 64:
                    new_pass = ""
                r_obj["password"] = new_pass
                if r_obj.get("persistent"):
                    db_upsert(room, new_pass, r_obj.get("owner_token", ""),
                              r_obj.get("url", ""),
                              title=r_obj.get("title", ""),
                              description=r_obj.get("description", ""),
                              image=r_obj.get("image", ""))
                await broadcast(room, {
                    "type": "password-changed",
                    "hasPassword": bool(new_pass),
                })
                await broadcast_room_list()
                log.info(f"password cambiata per {room!r}")
                continue

            if t == "create-persistent":
                name = msg.get("name") or ""
                password = msg.get("password") or ""
                url = sanitize_url(msg.get("url") or "")

                if not name or len(name) > 64 or not url:
                    try:
                        await ws.send(json.dumps({
                            "type": "error",
                            "code": "invalid",
                            "message": "Nome e URL sono obbligatori",
                        }))
                    except Exception:
                        pass
                    continue

                if not isinstance(password, str):
                    password = ""
                password = password[:64]

                existing = ROOMS.get(name)
                if existing is not None:
                    try:
                        await ws.send(json.dumps({
                            "type": "error",
                            "code": "already_exists",
                            "message": "La stanza esiste gia'",
                        }))
                    except Exception:
                        pass
                    continue

                token = secrets.token_urlsafe(16)
                ROOMS[name] = {
                    "title": "",
                    "description": "",
                    "image": "",
                    "clients": set(),
                    "authors": {},
                    "chat": [],
                    "state": None,
                    "password": password,
                    "owner_token": token,
                    "url": url,
                    "created_at": time.time(),
                    "cleanup_task": None,
                    "persistent": True,
                }
                db_upsert(name, password, token, url)
                await broadcast_room_list()
                log.info(f"stanza persistente creata da /watch: {name!r} url={url!r}")

                try:
                    await ws.send(json.dumps({
                        "type": "persistent-created",
                        "name": name,
                        "ownerToken": token,
                        "hasPassword": bool(password),
                    }))
                except Exception:
                    pass
                continue

            if t == "delete-room":
                if room is None or room not in ROOMS:
                    continue
                r_obj = ROOMS[room]
                ot = msg.get("ownerToken") or ""
                if not is_owner(r_obj, ot):
                    try:
                        await ws.send(json.dumps({
                            "type": "error",
                            "code": "not_owner",
                            "message": "Solo il creatore puo' cancellare la stanza",
                        }))
                    except Exception:
                        pass
                    continue
                db_delete(room)
                for peer in tuple(r_obj["clients"]):
                    try:
                        await peer.send(json.dumps({
                            "type": "room-deleted",
                            "room": room,
                        }))
                    except Exception:
                        pass
                ROOMS.pop(room, None)
                await broadcast_room_list()
                log.info(f"stanza cancellata dall'owner: {room!r}")
                continue

            if room is None:
                continue

            r = msg.get("room")
            if not r or not isinstance(r, str) or len(r) > 64:
                continue

            if room != r:
                if r not in ROOMS:
                    continue
                await leave(room, ws)
                room = r
                join(room, ws)
                ROOMS[room]["authors"][ws] = my_author

            peers = ROOMS.get(room, {}).get("clients", set())
            if not peers:
                continue

            if t == "update-url":
                new_url = sanitize_url(msg.get("url") or "")
                if not new_url:
                    continue
                if new_url == ROOMS[room].get("url", ""):
                    continue
                ROOMS[room]["url"] = new_url
                if msg.get("title"):
                    ROOMS[room]["title"] = (msg.get("title") or "").strip()[:200]
                if msg.get("description"):
                    ROOMS[room]["description"] = (msg.get("description") or "").strip()[:300]
                if ROOMS[room].get("persistent"):
                    db_upsert(
                        room,
                        ROOMS[room].get("password", ""),
                        ROOMS[room].get("owner_token", ""),
                        new_url,
                        title=ROOMS[room].get("title", ""),
                        description=ROOMS[room].get("description", ""),
                        image=ROOMS[room].get("image", ""),
                    )
                log.info(f"URL aggiornato per {room!r}: -> {new_url!r}")
                await broadcast(room, {
                    "type": "url-updated",
                    "room": room,
                    "url": new_url,
                }, skip=ws)
                await broadcast_room_list()
                continue

            if t == "update-meta":
                new_title = (msg.get("title") or "").strip()[:200]
                new_desc = (msg.get("description") or "").strip()[:300]
                new_image = (msg.get("image") or "").strip()[:300]
                if new_title:
                    ROOMS[room]["title"] = new_title
                if new_desc:
                    ROOMS[room]["description"] = new_desc
                if new_image:
                    ROOMS[room]["image"] = new_image
                if ROOMS[room].get("persistent"):
                    db_upsert(
                        room,
                        ROOMS[room].get("password", ""),
                        ROOMS[room].get("owner_token", ""),
                        ROOMS[room].get("url", ""),
                        title=ROOMS[room].get("title", ""),
                        description=ROOMS[room].get("description", ""),
                        image=ROOMS[room].get("image", ""),
                    )
                log.info(f"meta aggiornato per {room!r}: {new_title!r}")
                await broadcast_room_list()
                continue

            if t == "chat":
                now = time.time()
                if now - last_chat_ts < CHAT_RATE_SEC:
                    continue
                last_chat_ts = now
                text = sanitize_chat(msg.get("text"))
                if not text:
                    continue
                author_msg = (msg.get("author") or "?")[:32]
                client_id = (msg.get("clientId") or "")[:64]
                entry = {
                    "type": "chat",
                    "author": author_msg,
                    "text": text,
                    "clientId": client_id,
                    "ts": now,
                }
                hist = ROOMS[room].setdefault("chat", [])
                hist.append(entry)
                if len(hist) > MAX_CHAT_HISTORY:
                    hist.pop(0)
                await asyncio.gather(
                    *(p.send(json.dumps(entry)) for p in tuple(peers)),
                    return_exceptions=True,
                )
                continue

            if t == "sync-request":
                hist = ROOMS[room].get("chat", [])
                try:
                    await ws.send(json.dumps({
                        "type": "sync",
                        "state": ROOMS[room].get("state"),
                        "chat": hist[-30:],
                    }))
                except Exception:
                    pass
                continue

            if t == "tick":
                await asyncio.gather(
                    *(p.send(raw) for p in tuple(peers) if p is not ws),
                    return_exceptions=True,
                )
                continue

            if t in ("play", "pause", "seek"):
                ROOMS[room]["state"] = {
                    "type": t,
                    "t": msg.get("t"),
                    "ts": time.time(),
                }
            await asyncio.gather(
                *(p.send(raw) for p in tuple(peers) if p is not ws),
                return_exceptions=True,
            )

    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        log.warning(f"handler eccezione: {e!r}")
    finally:
        LISTENERS.discard(ws)
        if room:
            await leave(room, ws, notify=True)


def join(room: str, ws) -> None:
    r = ROOMS.setdefault(room, {
        "title": "", "description": "", "image": "",
        "clients": set(), "authors": {}, "chat": [], "state": None,
        "password": "", "owner_token": "", "url": "",
        "created_at": time.time(), "cleanup_task": None,
        "persistent": False,
    })
    r["clients"].add(ws)


async def leave(room: str, ws, notify: bool = False) -> None:
    r = ROOMS.get(room)
    if not r:
        return
    r["clients"].discard(ws)
    author = r.get("authors", {}).pop(ws, None)
    if notify and author:
        await broadcast(room, {
            "type": "presence",
            "action": "left",
            "author": author,
            "clients": len(r["clients"]),
        }, skip=ws)

    if not r["clients"]:
        cancel_cleanup(r)

        async def _cleanup():
            try:
                await asyncio.sleep(ROOM_IDLE_TTL)
                current = ROOMS.get(room)
                if not current or current["clients"]:
                    return
                if current.get("persistent"):
                    log.info(f"stanza persistente mantenuta: {room!r}")
                    return
                TOMBSTONES[room] = {
                    "password": current.get("password", ""),
                    "expires_at": time.time() + TOMBSTONE_TTL,
                }
                ROOMS.pop(room, None)
                await broadcast_room_list()
                log.info(f"stanza rimossa (tombstone {TOMBSTONE_TTL}s): {room!r}")
            except asyncio.CancelledError:
                pass

        try:
            r["cleanup_task"] = asyncio.create_task(_cleanup())
        except RuntimeError:
            pass
    else:
        await broadcast_room_list()


async def main():
    db_init()
    loaded = db_load_all()
    for name, data in loaded.items():
        ROOMS[name] = {
            "title": data.get("title", ""),
            "description": data.get("description", ""),
            "image": data.get("image", ""),
            "clients": set(), "authors": {}, "chat": [], "state": None,
            "password": data["password"],
            "owner_token": data["owner_token"],
            "url": data["url"],
            "created_at": data["created_at"],
            "cleanup_task": None,
            "persistent": True,
        }
        log.info(f"caricata stanza persistente: {name!r}")

    if not ADMIN_PASS:
        log.warning("WT_ADMIN_PASS non impostata -> login admin DISABILITATO")
    log.info(f"WT relay su {HOST}:{PORT} (TTL={ROOM_IDLE_TTL}s, tombstone={TOMBSTONE_TTL}s, {len(loaded)} stanze persistenti)")
    async with websockets.serve(
        handler, HOST, PORT,
        ping_interval=30, ping_timeout=30,
        max_size=4096, max_queue=32, compression=None,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
