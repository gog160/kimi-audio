from flask import Flask, request, jsonify
import yt_dlp
import os
import tempfile
import base64

app = Flask(__name__)
COOKIES_FILE = None
CACHE = {}

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
    search_opts = {
        'quiet': True,
        'skip_download': True,
        'extract_flat': True,
        'noplaylist': True,
    }
    with yt_dlp.YoutubeDL(search_opts) as ydl:
        r = ydl.extract_info(f'ytsearch1:{query}', download=False)
        video_id = r['entries'][0]['id']
        title = r['entries'][0].get('title', query)

    stream_opts = {
        'quiet': True,
        'skip_download': True,
        'noplaylist': True,
        'format': 'bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio/best',
        'geo_bypass': True,
        'geo_bypass_country': 'US',
    }
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        stream_opts['cookiefile'] = COOKIES_FILE

    with yt_dlp.YoutubeDL(stream_opts) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)

    return info['url'], info.get('title', title)

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'no query'}), 400
    if q in CACHE:
        url, title = CACHE[q]
        return jsonify({'url': url, 'title': title, 'cached': True})
    try:
        url, title = get_stream(q)
        CACHE[q] = (url, title)
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
