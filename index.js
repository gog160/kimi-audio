const express = require('express');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 10000;

// ================= CONFIGURACIÓN =================
const TTL              = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const TIMEOUT_FAST     = 20000;   // Alexa: 20s máximo
const TIMEOUT_SLOW     = 45000;   // /bajar: 45s sin prisa
const MAX_CONCURRENCY  = 2;

const YT_CLIENTS = ['tv_embedded', 'tv', 'web_safari', 'web'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'
];

// ================= CACHÉ =================
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > TTL) cache.delete(key);
  }
}, CLEANUP_INTERVAL);

let activeRequests = 0;

// ================= HELPERS =================
function normalizeQuery(q) { return q.trim().toLowerCase(); }
function safeQuery(q) { return q.replace(/[`$\\;"']/g, ''); }
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function isHLS(url) {
  return url.includes('.m3u8') || url.includes('playlist') || url.includes('m3u8');
}

function execPromise(cmd, timeout = TIMEOUT_FAST) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ================= YOUTUBE (anti-HLS estricto) =================
async function resolveYoutube(query, timeout = TIMEOUT_FAST) {
  const ua   = randomUA();
  const safeQ = safeQuery(query);

  // Formatos en orden de preferencia — todos excluyen HLS explícitamente
  const formats = [
    'bestaudio[ext=m4a][protocol^=https]',
    'bestaudio[ext=mp3][protocol^=https]',
    'bestaudio[ext=m4a]',
    'bestaudio[ext=mp3]',
    'bestaudio[protocol!=m3u8][protocol!=m3u8_native]',
  ];

  for (const client of YT_CLIENTS) {
    for (const fmt of formats) {
      try {
        const cmd = `./yt-dlp --no-playlist \
          -f "${fmt}" \
          --extractor-args "youtube:player_client=${client}" \
          --user-agent "${ua}" \
          --geo-bypass \
          --match-filter "!is_live" \
          --no-warnings \
          -g "ytsearch1:${safeQ}"`;

        const url = await execPromise(cmd, timeout);
        if (url && url.startsWith('http') && !isHLS(url)) {
          console.log(`✅ YouTube (${client}/${fmt.split('[')[0]}): ${query}`);
          return { url, source: `youtube_${client}` };
        }
      } catch (e) {
        // Continuar con siguiente formato/cliente
      }
    }
  }
  throw new Error('YouTube no devolvió URL directa');
}

// ================= SOUNDCLOUD (forzar MP3 directo) =================
async function resolveSoundcloud(query, timeout = TIMEOUT_FAST) {
  const safeQ = safeQuery(query);

  // Intentar formatos directos en orden
  const formats = [
    'bestaudio[ext=mp3][protocol^=https]',
    'bestaudio[ext=mp3]',
    'bestaudio[protocol!=m3u8][protocol!=m3u8_native][ext!=m3u8]',
    'worstaudio[ext=mp3]',  // último recurso: peor calidad pero directo
  ];

  for (const fmt of formats) {
    try {
      const cmd = `./yt-dlp --no-playlist \
        -f "${fmt}" \
        --no-warnings \
        -g "scsearch1:${safeQ}"`;

      const url = await execPromise(cmd, timeout);
      if (url && url.startsWith('http') && !isHLS(url)) {
        console.log(`✅ SoundCloud (${fmt.split('[')[0]}): ${query}`);
        return { url, source: 'soundcloud' };
      }
    } catch (e) {
      // Continuar
    }
  }

  // Último intento: URL directa sin filtro de formato pero verificar que no es HLS
  try {
    const cmd = `./yt-dlp --no-playlist --no-warnings -g "scsearch1:${safeQ}"`;
    const stdout = await execPromise(cmd, timeout);
    const urls = stdout.split('\n').filter(u => u.startsWith('http'));
    const directUrl = urls.find(u => !isHLS(u));
    if (directUrl) {
      console.log(`✅ SoundCloud (directo): ${query}`);
      return { url: directUrl, source: 'soundcloud_direct' };
    }
  } catch (e) {}

  throw new Error('SoundCloud no devolvió MP3 directo');
}

// ================= OBTENER AUDIO =================
async function getAudio(query, slow = false) {
  const timeout = slow ? TIMEOUT_SLOW : TIMEOUT_FAST;

  // Para /bajar (slow=true): YouTube primero con más tiempo
  // Para Alexa (slow=false): SoundCloud primero (más rápido)
  if (slow) {
    try { return await resolveYoutube(query, timeout); } catch (e) {
      console.log('YouTube falló → SoundCloud');
    }
    try { return await resolveSoundcloud(query, timeout); } catch (e) {}
  } else {
    try { return await resolveSoundcloud(query, timeout); } catch (e) {
      console.log('SoundCloud falló → YouTube');
    }
    try { return await resolveYoutube(query, timeout); } catch (e) {}
  }

  throw new Error(`No se encontró URL directa para: ${query}`);
}

// ================= ENDPOINT /audio (Alexa — rápido) =================
app.get('/audio', async (req, res) => {
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) return res.status(400).json({ error: 'Falta parámetro q' });

  const query = normalizeQuery(rawQuery);
  const cached = cache.get(query);
  if (cached && !isHLS(cached.url)) {
    return res.json({ url: cached.url, title: cached.title, source: cached.source, cached: true });
  }

  if (activeRequests >= MAX_CONCURRENCY)
    return res.status(429).json({ error: 'Demasiadas peticiones' });

  activeRequests++;
  try {
    const result = await getAudio(query, false);
    let title = rawQuery;
    try {
      title = await execPromise(`./yt-dlp --no-warnings --get-title "scsearch1:${safeQuery(query)}"`, 8000);
    } catch (_) {}
    cache.set(query, { url: result.url, title, source: result.source, timestamp: Date.now() });
    res.json({ url: result.url, title, source: result.source, cached: false });
  } catch (e) {
    console.error(`❌ /audio error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    activeRequests--;
  }
});

// ================= ENDPOINT /download (sin prisa — YouTube primero) =================
app.get('/download', async (req, res) => {
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) return res.status(400).json({ error: 'Falta parámetro q' });

  const query = normalizeQuery(rawQuery);

  // Cache hit válido
  const cached = cache.get(query);
  if (cached && !isHLS(cached.url)) {
    return res.json({ url: cached.url, title: cached.title, source: cached.source, cached: true });
  }

  activeRequests++;
  try {
    // Sin límite de concurrencia para descargas — son asíncronas desde KIMI
    const result = await getAudio(query, true);  // slow=true → YouTube primero
    let title = rawQuery;
    try {
      const src = result.source.startsWith('youtube') ? 'ytsearch1' : 'scsearch1';
      title = await execPromise(`./yt-dlp --no-warnings --get-title "${src}:${safeQuery(query)}"`, 10000);
    } catch (_) {}
    cache.set(query, { url: result.url, title, source: result.source, timestamp: Date.now() });
    res.json({ url: result.url, title, source: result.source, cached: false });
  } catch (e) {
    console.error(`❌ /download error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    activeRequests--;
  }
});

// ================= ENDPOINTS UTILIDAD =================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheSize: cache.size, active: activeRequests, uptime: Math.floor(process.uptime()) });
});

app.get('/debug', async (req, res) => {
  try {
    const version = await execPromise('./yt-dlp --version', 5000);
    res.json({ yt_dlp: version, node: process.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= START =================
app.listen(port, () => console.log(`🚀 kimi-audio en puerto ${port}`));
