const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

// ================= CONFIGURACIÓN =================
const TTL = 6 * 60 * 60 * 1000;          // 6 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos
const REQUEST_TIMEOUT = 20000;            // 20 segundos
const MAX_CONCURRENT = 2;                  // Máximo de procesos yt-dlp simultáneos

// Clientes de YouTube en orden de preferencia (android suele ser el más permisivo)
const YT_CLIENTS = ['android', 'ios', 'tv_embedded', 'web'];

// Lista de user‑agents realistas (rotación)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 Chrome/112.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
];

// ================= COOKIES (desde variable de entorno) =================
let COOKIES_FILE = null;
if (process.env.YOUTUBE_COOKIES_BASE64) {
  try {
    const cookieContent = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf-8');
    const tmpPath = path.join(os.tmpdir(), 'cookies.txt');
    fs.writeFileSync(tmpPath, cookieContent);
    COOKIES_FILE = tmpPath;
    console.log('✅ Cookies cargadas desde YOUTUBE_COOKIES_BASE64');
  } catch (e) {
    console.error('⚠️ Error al procesar cookies:', e.message);
  }
}

// ================= CACHÉ EN MEMORIA =================
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, { timestamp }] of cache) {
    if (now - timestamp > TTL) cache.delete(key);
  }
}, CLEANUP_INTERVAL);

// ================= CONTROL DE CONCURRENCIA =================
let activeRequests = 0;

// ================= FUNCIONES AUXILIARES =================
function normalizeQuery(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

function safeQuery(q) {
  // Elimina caracteres peligrosos para la shell, pero conserva acentos y ñ
  return q.replace(/[`$\\;"']/g, '');
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function execPromise(cmd, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ================= OBTENER URL DE AUDIO =================
async function getAudioUrl(query) {
  const safeQ = safeQuery(query);
  const ua = getRandomUserAgent();

  // Intentar con cada cliente de YouTube
  for (const client of YT_CLIENTS) {
    try {
      let cmd = `./yt-dlp -f "bestaudio[ext=m4a]/bestaudio" \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}"`;
      if (COOKIES_FILE) cmd += ` --cookies "${COOKIES_FILE}"`;
      cmd += ` -g "ytsearch1:${safeQ}"`;

      const url = await execPromise(cmd);
      if (url) return url;
    } catch (err) {
      console.log(`Cliente YouTube "${client}" falló: ${err.message}`);
    }
  }

  // Fallback: SoundCloud
  try {
    let cmd = `./yt-dlp -f "bestaudio" -g "scsearch1:${safeQ}"`;
    if (COOKIES_FILE) cmd += ` --cookies "${COOKIES_FILE}"`; // opcional, pero por si acaso
    const url = await execPromise(cmd);
    if (url) return url;
  } catch (err) {
    console.log(`Fallback SoundCloud falló: ${err.message}`);
  }

  throw new Error('No se pudo obtener audio de YouTube ni SoundCloud');
}

// ================= ENDPOINT PRINCIPAL =================
app.get('/audio', async (req, res) => {
  const rawQuery = req.query.q;
  if (!rawQuery) {
    return res.status(400).json({ error: 'Falta el parámetro "q"' });
  }

  const query = normalizeQuery(rawQuery);
  console.log(`🔍 Búsqueda: "${rawQuery}" → "${query}"`);

  // 1. Consultar caché
  const cached = cache.get(query);
  if (cached) {
    console.log(`✔ Cache hit para "${query}"`);
    return res.json({ url: cached.url, cached: true });
  }

  // 2. Control de concurrencia
  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Demasiadas peticiones, inténtalo más tarde' });
  }
  activeRequests++;

  try {
    // 3. Obtener URL
    const url = await getAudioUrl(query);
    cache.set(query, { url, timestamp: Date.now() });
    console.log(`🎵 URL obtenida para "${query}"`);
    res.json({ url, cached: false });
  } catch (err) {
    console.error(`❌ Error para "${query}": ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    activeRequests--;
  }
});

// ================= ENDPOINTS DE UTILIDAD =================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: cache.size,
    activeRequests,
    uptime: process.uptime()
  });
});

app.get('/debug', async (req, res) => {
  try {
    const version = await execPromise('./yt-dlp --version');
    res.send(`yt-dlp versión: ${version}`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ================= INICIAR SERVIDOR =================
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
