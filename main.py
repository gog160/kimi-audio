from flask import Flask, request, jsonify
import yt_dlp
import os
import tempfile

app = Flask(__name__)
COOKIES_FILE = None

def init_cookies():
    global COOKIES_FILE
    cookies = os.environ.get('YOUTUBE_COOKIES', '').strip()
    if not cookies:
        return None
    tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
    tmp.write(cookies)
    tmp.close()
    COOKIES_FILE = tmp.name
    print(f"Cookies loaded: {COOKIES_FILE}")
    return COOKIES_FILE

init_cookies()

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '')
    if not q:
        return jsonify({'error': 'no query'}), 400
    try:
        ydl_opts = {
            'quiet': False,
            'format': 'worstaudio/worst',
            'noplaylist': True,
        }
        if COOKIES_FILE and os.path.exists(COOKIES_FILE):
            ydl_opts['cookiefile'] = COOKIES_FILE
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch1:{q}', download=False)
            entry = info['entries'][0]
            url = entry['url']
            title = entry.get('title', q)
            return jsonify({'url': url, 'title': title})
    except Exception as e:
        print(f"ERROR: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    cookies_ok = COOKIES_FILE and os.path.exists(COOKIES_FILE)
    return jsonify({'status': 'ok', 'cookies': cookies_ok})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
