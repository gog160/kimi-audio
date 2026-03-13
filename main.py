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
        print("WARNING: YOUTUBE_COOKIES not set")
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
            'format': 'bestaudio[ext=webm]/bestaudio/best',
            'noplaylist': True,
            'extractor_args': {'youtube': {'player_client': ['android']}},
        }
        if COOKIES_FILE and os.path.exists(COOKIES_FILE):
            ydl_opts['cookiefile'] = COOKIES_FILE
            print(f"Using cookies from {COOKIES_FILE}")
        else:
            print("No cookies file available")

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch1:{q}', download=False)
            entry = info['entries'][0]
            # Buscar mejor formato de audio
            best_url = None
            for f in entry.get('formats', []):
                if f.get('acodec') != 'none' and f.get('vcodec') == 'none':
                    if f.get('url'):
                        best_url = f['url']
                        break
            if not best_url:
                best_url = entry['url']
            title = entry.get('title', q)
            return jsonify({'url': best_url, 'title': title})
    except Exception as e:
        print(f"ERROR: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    cookies_ok = COOKIES_FILE and os.path.exists(COOKIES_FILE)
    return jsonify({'status': 'ok', 'cookies': cookies_ok})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
