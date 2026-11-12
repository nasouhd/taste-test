#!/usr/bin/env python3
"""Taste Test — a multiplayer "rank your friends' picks" party game.

Zero dependencies: run `python3 server.py` and open http://localhost:8000
Players on the same Wi-Fi can join using the LAN address printed at startup.
"""
import json
import os
import random
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from cards import DELUXE, STANDARD

PORT = int(os.environ.get("PORT", "8000"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
HAND_SIZE = 5            # classic: cards in hand
DELUXE_DEAL = 3          # deluxe: cards dealt from the turn's category
MIN_PLAYERS = 3
MAX_PLAYERS = {"standard": 8, "deluxe": 7}   # deluxe: max 6 submissions to score 1-6
OFFLINE_AFTER = 10       # seconds without a poll before a player counts as offline
HOST_HANDOFF_AFTER = 20  # seconds the host may be offline before hosting moves on
ROOM_TTL = 60 * 60       # drop rooms idle for an hour

LOCK = threading.RLock()
ROOMS = {}
_card_seq = [0]


def new_card(text, cat=None):
    _card_seq[0] += 1
    c = {"id": "c%d" % _card_seq[0], "text": text}
    if cat:
        c["cat"] = cat
    return c


def new_code():
    letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    while True:
        code = "".join(random.choice(letters) for _ in range(4))
        if code not in ROOMS:
            return code


class GameError(Exception):
    pass


class Room:
    def __init__(self):
        self.code = new_code()
        self.players = []          # list of dicts, join order
        self.host_id = None
        self.settings = {"mode": "standard", "cycles": 1, "direction": "favorite"}
        self.phase = "lobby"       # lobby | submit | rank | reveal | over
        self.game = None
        self.version = 0
        self.touched = time.time()

    # ---- helpers -------------------------------------------------------
    def bump(self):
        self.version += 1

    def player(self, pid):
        for p in self.players:
            if p["id"] == pid:
                return p
        return None

    def auth(self, pid, token):
        p = self.player(pid)
        if not p or p["token"] != token:
            raise GameError("You're not in this room.")
        return p

    def online(self, p):
        return time.time() - p["seen"] < OFFLINE_AFTER

    def add_player(self, name):
        name = (name or "").strip()[:20]
        if not name:
            raise GameError("Enter a name.")
        if self.phase != "lobby":
            raise GameError("That game already started.")
        if any(p["name"].lower() == name.lower() for p in self.players):
            raise GameError("That name is taken in this room.")
        if len(self.players) >= MAX_PLAYERS["standard"]:
            raise GameError("Room is full.")
        p = {"id": secrets.token_hex(4), "token": secrets.token_hex(16), "name": name,
             "score": 0, "seen": time.time()}
        self.players.append(p)
        if not self.host_id:
            self.host_id = p["id"]
        self.bump()
        return p

    # ---- upkeep run on every request -----------------------------------
    def maintain(self):
        now = time.time()
        status = tuple(self.online(p) for p in self.players)
        if status != getattr(self, "_last_status", None):
            self._last_status = status
            self.bump()
        host = self.player(self.host_id)
        if host and now - host["seen"] > HOST_HANDOFF_AFTER:
            nxt = next((p for p in self.players if self.online(p)), None)
            if nxt and nxt["id"] != self.host_id:
                self.host_id = nxt["id"]
                self.bump()
        if self.phase == "submit":
            self.check_submissions()

    # ---- game flow -----------------------------------------------------
    def start(self):
        n = len(self.players)
        mode = self.settings["mode"]
        if n < MIN_PLAYERS:
            raise GameError("Need at least %d players." % MIN_PLAYERS)
        if n > MAX_PLAYERS[mode]:
            raise GameError("Deluxe mode supports up to %d players." % MAX_PLAYERS[mode])
        for p in self.players:
            p["score"] = 0
        order = [p["id"] for p in self.players]
        random.shuffle(order)
        g = {
            "order": order,
            "turn": 0,
            "total": len(order) * self.settings["cycles"],
            "hands": {pid: [] for pid in order},
            "deck": [],
            "cat_decks": {},
            "cat_cycle": [],
        }
        self.game = g
        if mode == "standard":
            for pid in order:
                g["hands"][pid] = [self.draw() for _ in range(HAND_SIZE)]
        self.start_turn()

    def draw(self):
        g = self.game
        if not g["deck"]:
            in_hands = {c["text"] for h in g["hands"].values() for c in h}
            g["deck"] = [new_card(t) for t in STANDARD if t not in in_hands]
            random.shuffle(g["deck"])
        return g["deck"].pop()

    def draw_cat(self, cat):
        g = self.game
        deck = g["cat_decks"].get(cat)
        if not deck:
            deck = [new_card(t, cat) for t in DELUXE[cat]["cards"]]
            random.shuffle(deck)
            g["cat_decks"][cat] = deck
        return deck.pop()

    def start_turn(self):
        g = self.game
        # Skip choosers who have dropped out.
        while g["turn"] < g["total"]:
            chooser = self.player(g["order"][g["turn"] % len(g["order"])])
            if chooser and self.online(chooser):
                break
            g["turn"] += 1
        if g["turn"] >= g["total"]:
            self.phase = "over"
            self.bump()
            return
        g["chooser"] = chooser["id"]
        d = self.settings["direction"]
        if d == "alternate":
            g["prompt"] = "favorite" if g["turn"] % 2 == 0 else "least"
        elif d == "random":
            g["prompt"] = random.choice(["favorite", "least"])
        else:
            g["prompt"] = d
        g["submissions"] = {}
        g["entries"] = []
        g["results"] = []
        g["category"] = None
        if self.settings["mode"] == "deluxe":
            if not g["cat_cycle"]:
                g["cat_cycle"] = list(DELUXE.keys())
                random.shuffle(g["cat_cycle"])
            cat = g["cat_cycle"].pop()
            g["category"] = cat
            seen = set()
            for pid in g["order"]:
                hand = []
                if pid != chooser["id"]:
                    while len(hand) < DELUXE_DEAL:
                        c = self.draw_cat(cat)
                        if c["text"] not in seen:
                            seen.add(c["text"])
                            hand.append(c)
                g["hands"][pid] = hand
        else:
            for pid in g["order"]:
                while len(g["hands"][pid]) < HAND_SIZE:
                    g["hands"][pid].append(self.draw())
        self.phase = "submit"
        self.bump()

    def submitters(self):
        g = self.game
        return [pid for pid in g["order"] if pid != g["chooser"]]

    def submit(self, p, card_id):
        g = self.game
        if self.phase != "submit":
            raise GameError("Not accepting cards right now.")
        if p["id"] == g["chooser"]:
            raise GameError("You're the chooser this turn.")
        if p["id"] not in g["order"]:
            raise GameError("You're not in this game.")
        if p["id"] in g["submissions"]:
            raise GameError("You already submitted.")
        hand = g["hands"][p["id"]]
        card = next((c for c in hand if c["id"] == card_id), None)
        if not card:
            raise GameError("That card isn't in your hand.")
        hand.remove(card)
        g["submissions"][p["id"]] = card
        self.bump()
        self.check_submissions()

    def check_submissions(self):
        g = self.game
        subs = g["submissions"]
        waiting = [pid for pid in self.submitters()
                   if pid not in subs and self.player(pid) and self.online(self.player(pid))]
        if waiting or not subs:
            return
        items = list(subs.items())
        random.shuffle(items)
        g["entries"] = [{"eid": secrets.token_hex(4), "pid": pid, "card": c} for pid, c in items]
        self.phase = "rank"
        self.bump()

    def rank(self, p, data):
        g = self.game
        if self.phase != "rank":
            raise GameError("Not ranking right now.")
        if p["id"] != g["chooser"]:
            raise GameError("Only the chooser can rank.")
        entries = {e["eid"]: e for e in g["entries"]}
        points = {}
        if self.settings["mode"] == "deluxe":
            scores = data.get("scores") or {}
            if set(scores.keys()) != set(entries.keys()):
                raise GameError("Score every card.")
            vals = []
            for eid, v in scores.items():
                if not isinstance(v, int) or not 1 <= v <= 6:
                    raise GameError("Scores must be 1–6.")
                vals.append(v)
            if len(set(vals)) != len(vals):
                raise GameError("Each card needs a different score.")
            points = dict(scores)
        else:
            order = data.get("order") or []
            if sorted(order) != sorted(entries.keys()):
                raise GameError("Rank every card.")
            # Chooser taps worst -> best, so the first card is worth 1 point.
            points = {eid: i + 1 for i, eid in enumerate(order)}
        results = []
        for eid, pts in points.items():
            e = entries[eid]
            pl = self.player(e["pid"])
            if pl:
                pl["score"] += pts
            results.append({"pid": e["pid"], "name": pl["name"] if pl else "?",
                            "card": e["card"], "points": pts})
        results.sort(key=lambda r: -r["points"])
        g["results"] = results
        self.phase = "reveal"
        self.bump()

    def next_turn(self):
        if self.phase != "reveal":
            raise GameError("Nothing to advance.")
        self.game["turn"] += 1
        self.start_turn()

    def skip_turn(self):
        if self.phase not in ("submit", "rank"):
            raise GameError("Can't skip right now.")
        g = self.game
        if self.settings["mode"] == "standard":   # hand submitted cards back
            for pid, c in g["submissions"].items():
                g["hands"][pid].append(c)
        g["turn"] += 1
        self.start_turn()

    # ---- what each player is allowed to see ----------------------------
    def view(self, pid):
        v = {
            "code": self.code, "you": pid, "hostId": self.host_id, "phase": self.phase,
            "settings": self.settings, "version": self.version,
            "limits": {"min": MIN_PLAYERS, "max": MAX_PLAYERS},
            "players": [{"id": p["id"], "name": p["name"], "score": p["score"],
                         "online": self.online(p)} for p in self.players],
        }
        g = self.game
        if self.phase != "lobby" and g:
            cat = g.get("category")
            gv = {
                "turn": min(g["turn"] + 1, g["total"]), "total": g["total"],
                "round": min(g["turn"] // len(g["order"]) + 1, self.settings["cycles"]),
                "order": g["order"],
                "chooser": g.get("chooser"), "prompt": g.get("prompt"),
                "category": {"name": cat, "emoji": DELUXE[cat]["emoji"]} if cat else None,
                "hand": g["hands"].get(pid, []),
                "submitted": list(g.get("submissions", {}).keys()),
                "mine": g.get("submissions", {}).get(pid),
                "entries": [{"eid": e["eid"], "card": e["card"]} for e in g.get("entries", [])]
                if self.phase == "rank" else [],
                "results": g.get("results", []) if self.phase in ("reveal",) else [],
            }
            v["game"] = gv
        return v


# ---- HTTP layer -----------------------------------------------------------
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


def cleanup():
    now = time.time()
    for code in [c for c, r in ROOMS.items() if now - r.touched > ROOM_TTL]:
        del ROOMS[code]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/state":
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            with LOCK:
                room = ROOMS.get(q.get("code", "").upper())
                if not room:
                    return self.send_json({"error": "Room not found.", "gone": True}, 404)
                try:
                    p = room.auth(q.get("pid"), q.get("token"))
                except GameError as e:
                    return self.send_json({"error": str(e), "gone": True}, 403)
                p["seen"] = room.touched = time.time()
                room.maintain()
                if q.get("v") == str(room.version):
                    return self.send_json({"same": True})
                return self.send_json(room.view(p["id"]))
        path = "/index.html" if url.path in ("/", "") else url.path
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_json({"error": "Bad request."}, 400)
        path = urlparse(self.path).path
        with LOCK:
            try:
                if path == "/api/create":
                    cleanup()
                    room = Room()
                    ROOMS[room.code] = room
                    p = room.add_player(data.get("name"))
                    return self.send_json({"code": room.code, "pid": p["id"], "token": p["token"]})
                if path == "/api/join":
                    room = ROOMS.get(str(data.get("code", "")).strip().upper())
                    if not room:
                        raise GameError("No room with that code.")
                    p = room.add_player(data.get("name"))
                    return self.send_json({"code": room.code, "pid": p["id"], "token": p["token"]})
                if path == "/api/action":
                    room = ROOMS.get(str(data.get("code", "")).upper())
                    if not room:
                        raise GameError("Room not found.")
                    p = room.auth(data.get("pid"), data.get("token"))
                    p["seen"] = room.touched = time.time()
                    self.act(room, p, data)
                    return self.send_json(room.view(p["id"]))
                return self.send_json({"error": "Not found."}, 404)
            except GameError as e:
                return self.send_json({"error": str(e)}, 400)

    def act(self, room, p, data):
        t = data.get("type")
        is_host = p["id"] == room.host_id
        g = room.game
        if t == "settings":
            if not is_host or room.phase != "lobby":
                raise GameError("Only the host can change settings.")
            s = data.get("settings") or {}
            if s.get("mode") in ("standard", "deluxe"):
                room.settings["mode"] = s["mode"]
            if s.get("cycles") in (1, 2):
                room.settings["cycles"] = s["cycles"]
            if s.get("direction") in ("favorite", "least", "alternate", "random"):
                room.settings["direction"] = s["direction"]
            room.bump()
        elif t == "start":
            if not is_host or room.phase != "lobby":
                raise GameError("Only the host can start.")
            room.start()
        elif t == "submit":
            room.submit(p, data.get("cardId"))
        elif t == "rank":
            room.rank(p, data)
        elif t == "next":
            if not (is_host or (g and p["id"] == g.get("chooser"))):
                raise GameError("Only the host or chooser can continue.")
            room.next_turn()
        elif t == "skip":
            if not is_host:
                raise GameError("Only the host can skip.")
            room.skip_turn()
        elif t == "again":
            if not is_host or room.phase != "over":
                raise GameError("Only the host can restart.")
            room.phase = "lobby"
            room.game = None
            for pl in room.players:
                pl["score"] = 0
            room.bump()
        elif t == "kick":
            if not is_host or room.phase != "lobby":
                raise GameError("Only the host can remove players in the lobby.")
            target = room.player(data.get("target"))
            if target and target["id"] != p["id"]:
                room.players.remove(target)
                room.bump()
        elif t == "leave":
            if room.phase == "lobby":
                room.players.remove(p)
                if room.host_id == p["id"]:
                    room.host_id = room.players[0]["id"] if room.players else None
                if not room.players:
                    del ROOMS[room.code]
            else:
                p["seen"] = 0
                if room.host_id == p["id"]:
                    nxt = next((x for x in room.players if room.online(x)), None)
                    room.host_id = nxt["id"] if nxt else room.host_id
                room.maintain()
            room.bump()
        else:
            raise GameError("Unknown action.")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def start_tunnel():
    """Open a public HTTPS link via localhost.run (uses the built-in ssh, no account)."""
    cmd = ["ssh", "-T", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30",
           "-o", "ExitOnForwardFailure=yes", "-R", "80:localhost:%d" % PORT, "nokey@localhost.run"]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
    except OSError as e:
        print("  ⚠️  Couldn't start the online tunnel (%s). Local play still works." % e)
        return None

    def watch():
        announced = False
        for line in proc.stdout:
            m = re.search(r"https://[\w.-]+\.(?:lhr\.life|localhost\.run)\b", line)
            if m and "admin." not in m.group(0) and not announced:
                announced = True
                print("\n  🌍 ONLINE — share this link with anyone, anywhere:")
                print("     %s\n" % m.group(0), flush=True)
        print("  ⚠️  The online link closed. Restart with --online to get a new one.", flush=True)

    threading.Thread(target=watch, daemon=True).start()
    return proc


if __name__ == "__main__":
    online = "--online" in sys.argv
    srv = None
    for attempt in range(20):
        try:
            srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
            break
        except OSError:
            if "PORT" in os.environ:   # an explicitly chosen port: don't silently move
                sys.exit("  Port %d is already in use. Try another, e.g. PORT=%d python3 server.py"
                         % (PORT, PORT + 1))
            PORT += 1
    if srv is None:
        sys.exit("  Couldn't find a free port.")
    print("\n  🍽️  Taste Test is running!")
    print("     On this computer:  http://localhost:%d" % PORT)
    ip = lan_ip()
    if ip:
        print("     Friends on Wi-Fi:  http://%s:%d" % (ip, PORT))
    tunnel = None
    if online:
        print("     Opening a public link…", flush=True)
        tunnel = start_tunnel()
    else:
        print("\n  Tip: run `python3 server.py --online` to get a link friends anywhere can use.")
    print("\n  Press Ctrl+C to stop.\n", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel:
            tunnel.terminate()
