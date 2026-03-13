from flask import Flask, request, jsonify
import yt_dlp
import os
import tempfile

app = Flask(__name__)

def get_cookies_file():
    cookies = os.environ.get('YOUTUBE_COOKIES', '')
    if not cookies:
        return None
    tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
    tmp.write(cookies)
    tmp.close()
    return tmp.name

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '')
    if not q:
        return jsonify({'error': 'no query'}), 400
    cookies_file = get_cookies_file()
    try:
        ydl_opts = {
            'quiet': True,
            'format': 'bestaudio',
            'noplaylist': True,
        }
        if cookies_file:
            ydl_opts['cookiefile'] = cookies_file
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch1:{q}', download=False)
            url = info['entries'][0]['formats'][-1]['url']
            title = info['entries'][0].get('title', q)
            return jsonify({'url': url, 'title': title})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        if cookies_file and os.path.exists(cookies_file):
            os.unlink(cookies_file)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
