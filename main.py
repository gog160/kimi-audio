from flask import Flask, request, jsonify
import yt_dlp
import requests
import os
import tempfile
import base64
import time
import sqlite3
import logging
import re

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

app = Flask(__name__)

# ── Configuración ──────────────────────────────────────────────
CACHE_TTL       = 15 * 86400   # 15 días metadatos
URL_CACHE_TTL   = 600          # 10 min URLs streaming
PENALTY_TIMEOUT = 60
PENALTY_ERROR   = 300
REQUEST_TIMEOUT = 4

PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.syncpundit.io",
    "https://pipedapi.adminforge.de",
]

COMMANDS = sorted([
    "pon música de", "quiero escuchar", "quiero oír",
    "reproduce", "ponme", "que suene", "pon"
], key=len, reverse=True)

STOPWORDS = {'el','la','los','las','un','una','de','del'}

# ── SQLite ─────────────────────────────────────────────────────
db = sqlite3.connect("cache.db", check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, video_id TEXT, title TEXT,
    timestamp INTEGER, source TEXT)""")
db.execute("""CREATE TABLE IF NOT EXISTS url_cache (
    video_id TEXT PRIMARY KEY, url TEXT,
    url_timestamp INTEGER, instance TEXT)""")
db.commit()

FAILED = {}
COOKIES_FILE = None

# ── Cookies ────────────────────────────────────────────────────
def init_cookies():
    global COOKIES_FILE
    b64 = os.environ.get("YOUTUBE_COOKIES_BASE64", "").strip()
    if not b64:
        return
    try:
        raw = base64.b64decode(b64).decode("utf-8")
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(raw)
        tmp.close()
        COOKIES_FILE = tmp.name
        logging.info(f"Cookies OK: {len(raw.splitlines())} líneas")
    except Exception as e:
        logging.error(f"Error cookies: {e}")

init_cookies()

# ── Helpers ────────────────────────────────────────────────────
def normalize(q):
    q = q.lower()
    q = re.sub(r'[^\w\s]', '', q)
    return ' '.join(w for w in q.split() if w not in STOPWORDS)

def extract_song(text):
    text = text.lower().strip()
    for cmd in COMMANDS:
        if text.startswith(cmd):
            return text[len(cmd):].strip()
    return text

# ── Piped ──────────────────────────────────────────────────────
def piped_search(query):
    for inst in PIPED_INSTANCES:
        if inst in FAILED and time.time() < FAILED[inst]:
            continue
        try:
            r = requests.get(f"{inst}/search", params={"q": query, "filter": "music_songs"},
                             timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            items = r.json().get("items", [])
            if not items:
                continue
            v = items[0]
            vid = v.get("url", "").replace("/watch?v=", "") or v.get("videoId", "")
            FAILED.pop(inst, None)
            return vid, v.get("title", query)
        except requests.Timeout:
            FAILED[inst] = time.time() + PENALTY_TIMEOUT
        except Exception as e:
            logging.warning(f"Piped search {inst}: {e}")
            FAILED[inst] = time.time() + PENALTY_ERROR
    return None

def piped_stream(video_id):
    for inst in PIPED_INSTANCES:
        if inst in FAILED and time.time() < FAILED[inst]:
            continue
        try:
            r = requests.get(f"{inst}/streams/{video_id}", timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            streams = r.json().get("audioStreams", [])
            for s in streams:
                if "audio/mp4" in s.get("mimeType", ""):
                    FAILED.pop(inst, None)
                    return s["url"], inst
            if streams:
                FAILED.pop(inst, None)
                return streams[0]["url"], inst
        except requests.Timeout:
            FAILED[inst] = time.time() + PENALTY_TIMEOUT
        except Exception as e:
            logging.warning(f"Piped stream {inst}: {e}")
            FAILED[inst] = time.time() + PENALTY_ERROR
    return None, None

# ── yt-dlp fallback ────────────────────────────────────────────
def ytdlp_resolve(query):
    opts = {
        "quiet": True, "skip_download": True,
        "extract_flat": True, "noplaylist": True, "force_ipv4": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        r = ydl.extract_info(f"ytsearch1:{query}", download=False)
        v = r["entries"][0]
        return v["id"], v.get("title", query)

def ytdlp_stream(video_id):
    opts = {
        "quiet": True, "skip_download": True,
        "noplaylist": True, "format": "bestaudio/best", "force_ipv4": True,
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        opts["cookiefile"] = COOKIES_FILE
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        return info["url"]

# ── URL con cache secundaria ───────────────────────────────────
def get_url(video_id, source):
    cur = db.cursor()
    cur.execute("SELECT url, url_timestamp FROM url_cache WHERE video_id=?", (video_id,))
    row = cur.fetchone()
    if row and time.time() - row[1] < URL_CACHE_TTL:
        return row[0]

    if source == "piped":
        url, inst = piped_stream(video_id)
        if not url:
            url = ytdlp_stream(video_id)
            inst = "ytdlp"
    else:
        url = ytdlp_stream(video_id)
        inst = "ytdlp"

    db.execute("REPLACE INTO url_cache (video_id, url, url_timestamp, instance) VALUES (?,?,?,?)",
               (video_id, url, int(time.time()), inst))
    db.commit()
    return url

# ── Endpoints ──────────────────────────────────────────────────
@app.route("/audio")
def audio():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "no query"}), 400

    q = extract_song(q)
    key = normalize(q)
    logging.info(f"Query: '{q}' -> key: '{key}'")

    cur = db.cursor()
    cur.execute("SELECT video_id, title, timestamp, source FROM cache WHERE key=?", (key,))
    row = cur.fetchone()
    if row:
        video_id, title, ts, source = row
        if time.time() - ts < CACHE_TTL:
            try:
                url = get_url(video_id, source)
                return jsonify({"url": url, "title": title, "cached": True, "source": source})
            except Exception as e:
                logging.error(f"Cache hit pero fallo URL: {e}")
                db.execute("DELETE FROM cache WHERE key=?", (key,))
                db.commit()

    # Piped primero
    result = piped_search(q)
    if result:
        video_id, title = result
        source = "piped"
        logging.info(f"Piped: {title} ({video_id})")
    else:
        # Fallback yt-dlp
        try:
            video_id, title = ytdlp_resolve(q)
            source = "ytdlp"
            logging.info(f"yt-dlp: {title} ({video_id})")
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    db.execute("REPLACE INTO cache (key, video_id, title, timestamp, source) VALUES (?,?,?,?,?)",
               (key, video_id, title, int(time.time()), source))
    db.commit()

    try:
        url = get_url(video_id, source)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"url": url, "title": title, "cached": False, "source": source})

@app.route("/health")
def health():
    cur = db.cursor()
    cur.execute("SELECT COUNT(*) FROM cache")
    c1 = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM url_cache")
    c2 = cur.fetchone()[0]
    return jsonify({
        "status": "ok",
        "cookies": bool(COOKIES_FILE),
        "cache": c1,
        "url_cache": c2,
        "failed_instances": len(FAILED)
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
