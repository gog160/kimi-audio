from flask import Flask, request, jsonify
import yt_dlp

app = Flask(__name__)

@app.route('/audio')
def get_audio():
    q = request.args.get('q', '')
    if not q:
        return jsonify({'error': 'no query'}), 400
    try:
        ydl_opts = {
            'quiet': True,
            'format': 'bestaudio',
            'noplaylist': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f'ytsearch1:{q}', download=False)
            url = info['entries'][0]['formats'][-1]['url']
            title = info['entries'][0].get('title', q)
            return jsonify({'url': url, 'title': title})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
