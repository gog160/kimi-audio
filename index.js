const express = require('express');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 10000;

// ================= CONFIGURACIÓN =================
const TTL              = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const REQUEST_TIMEOUT  = 20000;
const MAX_CONCURRENCY  = 2;

// Clientes YouTube sin PO Token
const YT_CLIENTS = ['tv_embedded', 'tv', 'web_safari', 'web'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
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

// ================= CONCURRENCIA SIMPLE (sin p-limit) =================
let activeRequests = 0;

// ================= HELPERS =================
function normalizeQuery(q) {
  return q.trim().toLowerCase();
}

function safeQuery(q) {
  return q.replace(/[`$\\;"']/g, '');
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function execPromise(cmd, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ================= YOUTUBE (con filtro anti-HLS) =================
async function resolveYoutube(query) {
  const ua = randomUA();
  const safeQ = safeQuery(query);

  for (const client of YT_CLIENTS) {
    try {
      // Filtro clave: protocol!=m3u8 evita HLS que Alexa no soporta
      const cmd = `./yt-dlp --no-playlist \
        -f "bestaudio[ext=m4a][protocol!=m3u8][protocol!=m3u8_native]/bestaudio[ext=mp3]/bestaudio[protocol!=m3u8][protocol!=m3u8_native]/bestaudio" \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}" \
        --geo-bypass \
        --match-filter "!is_live" \
        --no-warnings \
        -g "ytsearch1:${safeQ}"`;

      const url = await execPromise(cmd);
      if (url && url.startsWith('http')) {
        console.log(`✅ YouTube (${client}): ${query}`);
        return { url, source: `youtube_${client}` };
      }
    } catch (e) {
      console.log(`⚠️ YouTube ${client}: ${e.message.slice(0, 80)}`);
    }
  }
  throw new Error('YouTube falló con todos los clientes');
}

// ================= SOUNDCLOUD (con filtro anti-HLS) =================
async function resolveSoundcloud(query) {
  const safeQ = safeQuery(query);
  try {
    // Intentar primero formato directo no-HLS
    const cmd = `./yt-dlp --no-playlist \
      -f "bestaudio[protocol!=m3u8][protocol!=m3u8_native]/bestaudio[ext=mp3]/bestaudio" \
      --no-warnings \
      -g "scsearch1:${safeQ}"`;
    const url = await execPromise(cmd);
    if (url && url.startsWith('http')) {
      console.log(`✅ SoundCloud: ${query}`);
      return { url, source: 'soundcloud' };
    }
  } catch (e) {
    console.log(`⚠️ SoundCloud: ${e.message.slice(0, 80)}`);
  }
  throw new Error('SoundCloud también falló');
}

// ================= OBTENER AUDIO =================
async function getAudio(query) {
  try {
    return await resolveYoutube(query);
  } catch (e) {
    console.log('YouTube falló → SoundCloud');
    return await resolveSoundcloud(query);
  }
}

// ================= ENDPOINT /audio =================
app.get('/audio', async (req, res) => {
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) return res.status(400).json({ error: 'Falta parámetro q' });

  const query = normalizeQuery(rawQuery);
  console.log(`🔍 Query: "${rawQuery}"`);

  // Cache hit
  const cached = cache.get(query);
  if (cached) {
    console.log(`📦 Cache hit: "${query}"`);
    return res.json({ url: cached.url, title: cached.title, source: cached.source, cached: true });
  }

  // Control concurrencia
  if (activeRequests >= MAX_CONCURRENCY) {
    return res.status(429).json({ error: 'Demasiadas peticiones simultáneas' });
  }

  activeRequests++;
  try {
    const result = await getAudio(query);

    // Obtener título
    let title = rawQuery;
    try {
      const titleCmd = `./yt-dlp --no-warnings --get-title "ytsearch1:${safeQuery(query)}"`;
      title = await execPromise(titleCmd, 10000);
    } catch (_) {}

    cache.set(query, { url: result.url, title, source: result.source, timestamp: Date.now() });
    res.json({ url: result.url, title, source: result.source, cached: false });
  } catch (e) {
    console.error(`❌ Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    activeRequests--;
  }
});

// ================= ENDPOINT /health =================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: cache.size,
    active: activeRequests,
    uptime: Math.floor(process.uptime())
  });
});

// ================= ENDPOINT /debug =================
app.get('/debug', async (req, res) => {
  try {
    const version = await execPromise('./yt-dlp --version', 5000);
    res.json({ yt_dlp: version, node: process.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= START =================
app.listen(port, () => {
  console.log(`🚀 kimi-audio escuchando en puerto ${port}`);
});
