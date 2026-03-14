from flask import Flask, request, jsonify
import yt_dlp
import os
import tempfile
import base64

app = Flask(__name__)
COOKIES_FILE = None

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

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '')
    if not q:
        return jsonify({'error': 'no query'}), 400
    try:
        ydl_opts = {
            'quiet': True,
            'format': 'bestaudio/best',
            'noplaylist': True,
        }
        if COOKIES_FILE and os.path.exists(COOKIES_FILE):
            ydl_opts['cookiefile'] = COOKIES_FILE
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch1:{q}', download=False)
            entry = info['entries'][0]
            best_url = None
            for f in entry.get('formats', []):
                if f.get('acodec') != 'none' and f.get('vcodec') == 'none':
                    if f.get('url'):
                        best_url = f['url']
                        break
            if not best_url:
                best_url = entry['url']
            return jsonify({'url': best_url, 'title': entry.get('title', q)})
    except Exception as e:
        print(f"ERROR: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'cookies': bool(COOKIES_FILE and os.path.exists(COOKIES_FILE))})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
