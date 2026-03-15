const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 10000;

// ── Config ─────────────────────────────────────────────────────
const TTL              = 6 * 60 * 60 * 1000;   // 6 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000;        // 10 min
const REQUEST_TIMEOUT  = 20000;                  // 20s
const MAX_CONCURRENT   = 2;

const YT_CLIENTS = ['android', 'ios', 'tv_embedded', 'web'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
];

// ── Cache ──────────────────────────────────────────────────────
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > TTL) cache.delete(key);
  }
}, CLEANUP_INTERVAL);

// ── Concurrencia simple ────────────────────────────────────────
let activeRequests = 0;

// ── Helpers ────────────────────────────────────────────────────
function normalize(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

function safeQuery(q) {
  // Preserva acentos y ñ, solo elimina caracteres peligrosos para shell
  return q.replace(/[`$\\;"']/g, '');
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function execCmd(cmd, timeout) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── Obtener URL de audio ───────────────────────────────────────
async function getAudioUrl(query) {
  const q = safeQuery(query);
  const ua = randomUA();

  // Intentar YouTube con distintos clientes
  for (const client of YT_CLIENTS) {
    try {
      const cmd = `./yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}" \
        --no-warnings \
        -g "ytsearch1:${q}"`;
      const url = await execCmd(cmd, REQUEST_TIMEOUT);
      if (url && url.startsWith('http')) {
        console.log(`✅ YouTube (${client}): ${query}`);
        return { url, source: `youtube_${client}` };
      }
    } catch (e) {
      console.log(`⚠️ YouTube ${client} falló: ${e.message.slice(0, 100)}`);
    }
  }

  // Fallback SoundCloud
  try {
    const cmd = `./yt-dlp -f "bestaudio/best" \
      --no-warnings \
      -g "scsearch1:${q}"`;
    const url = await execCmd(cmd, REQUEST_TIMEOUT);
    if (url && url.startsWith('http')) {
      console.log(`✅ SoundCloud: ${query}`);
      return { url, source: 'soundcloud' };
    }
  } catch (e) {
    console.log(`⚠️ SoundCloud falló: ${e.message.slice(0, 100)}`);
  }

  throw new Error('No se pudo obtener audio de ninguna fuente');
}

// ── Endpoints ──────────────────────────────────────────────────
app.get('/audio', async (req, res) => {
  const raw = (req.query.q || '').trim();
  if (!raw) return res.status(400).json({ error: 'Falta parámetro q' });

  const key = normalize(raw);
  console.log(`🔍 Query: "${raw}"`);

  // Cache
  const cached = cache.get(key);
  if (cached) {
    console.log(`📦 Cache hit: "${key}"`);
    return res.json({ url: cached.url, title: cached.title, source: cached.source, cached: true });
  }

  // Control de concurrencia
  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Demasiadas peticiones simultáneas' });
  }

  activeRequests++;
  try {
    const result = await getAudioUrl(key);

    // Obtener título
    let title = raw;
    try {
      const titleCmd = `./yt-dlp --no-warnings --get-title "ytsearch1:${safeQuery(key)}"`;
      title = await execCmd(titleCmd, 10000);
    } catch (_) {}

    cache.set(key, { url: result.url, title, source: result.source, timestamp: Date.now() });
    res.json({ url: result.url, title, source: result.source, cached: false });
  } catch (e) {
    console.error(`❌ Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    activeRequests--;
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache: cache.size,
    active: activeRequests,
    uptime: Math.floor(process.uptime())
  });
});

app.get('/debug', async (req, res) => {
  try {
    const version = await execCmd('./yt-dlp --version', 5000);
    res.json({ yt_dlp: version, node: process.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 kimi-audio escuchando en puerto ${port}`);
});
