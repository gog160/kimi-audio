from flask import Flask, request, jsonify
import yt_dlp
import os
import tempfile
import base64
import time
import threading

app = Flask(__name__)
COOKIES_FILE = None
CACHE = {}
CACHE_TTL = 4 * 3600  # 4 horas

def init_cookies():
    global COOKIES_FILE
    b64 = os.environ.get('YOUTUBE_COOKIES_BASE64', '').strip()
    if not b64:
        print("WARNING: YOUTUBE_COOKIES_BASE64 not set")
        return None
    try:
        raw = base64.b64decode(b64).decode('utf-8')
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
        tmp.write(raw)
        tmp.close()
        COOKIES_FILE = tmp.name
        print(f"Cookies OK: {len(raw.splitlines())} líneas")
        return COOKIES_FILE
    except Exception as e:
        print(f"ERROR decoding cookies: {e}")
        return None

init_cookies()

def get_stream(query):
    ydl_opts = {
    'quiet': True,
    'skip_download': True,
    'noplaylist': True,
    'format': '140/251/250/249/139/171/bestaudio/best',
    'default_search': 'ytsearch1',
    'geo_bypass': True,
    'geo_bypass_country': 'US',
    'force_ipv4': True,
    'extract_flat': False,
}
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts['cookiefile'] = COOKIES_FILE

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(query, download=False)
        if 'entries' in info:
            info = info['entries'][0]
        return info['url'], info.get('title', query)

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '').strip().lower()
    if not q:
        return jsonify({'error': 'no query'}), 400

    # Cache con TTL
    if q in CACHE:
        url, title, ts = CACHE[q]
        if time.time() - ts < CACHE_TTL:
            return jsonify({'url': url, 'title': title, 'cached': True})

    try:
        url, title = get_stream(q)
        CACHE[q] = (url, title, time.time())
        return jsonify({'url': url, 'title': title, 'cached': False})
    except Exception as e:
        print(f"ERROR: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'cookies': bool(COOKIES_FILE and os.path.exists(COOKIES_FILE)),
        'cache': len(CACHE)
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
