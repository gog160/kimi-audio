const express = require('express');
const { exec } = require('child_process');
const pLimit = require('p-limit');

const app = express();
const port = process.env.PORT || 3000;

// ================= CONFIGURACIÓN =================
const TTL = 6 * 60 * 60 * 1000;          // 6 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos
const REQUEST_TIMEOUT = 15000;            // 15 segundos
const MAX_CONCURRENCY = 2;                 // Procesos simultáneos

// Clientes de YouTube que NO requieren PO Token (actualmente)
const YT_CLIENTS = ['tv_embedded', 'web'];

// Lista de user‑agents realistas (rotación)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'
];

// ================= CACHÉ EN MEMORIA =================
const cache = new Map();

// Limpieza periódica de entradas expiradas
setInterval(() => {
  const now = Date.now();
  for (const [key, { timestamp }] of cache) {
    if (now - timestamp > TTL) cache.delete(key);
  }
}, CLEANUP_INTERVAL);

// ================= LIMITADOR DE CONCURRENCIA =================
const limit = pLimit(MAX_CONCURRENCY);

// ================= FUNCIONES AUXILIARES =================
// Normaliza la consulta (por ahora solo trim, pero podrías añadir más)
function normalizeQuery(q) {
  return q.trim();
}

// Sanitiza la consulta para evitar inyección de comandos en shell
function safeQuery(q) {
  // Elimina caracteres peligrosos: ` $ \ ; " '
  return q.replace(/[`$\\;"']/g, '');
}

// Devuelve un user‑agent aleatorio de la lista
function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Ejecuta un comando y devuelve stdout como promesa
function execPromise(cmd, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ================= RESOLVER YOUTUBE =================
async function resolveYoutube(query) {
  const ua = randomUA();
  const safeQ = safeQuery(query);

  for (const client of YT_CLIENTS) {
    try {
      // Priorizamos formato m4a para mejor compatibilidad con Alexa,
      // pero si no existe, bestaudio elige el mejor disponible.
      const cmd = `./yt-dlp --no-playlist -f "bestaudio[ext=m4a]/bestaudio" \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}" \
        -g "ytsearch1:${safeQ}"`;

      const stdout = await execPromise(cmd);
      const url = stdout.trim();
      if (url) return url;
    } catch (e) {
      console.log(`Cliente YouTube "${client}" falló: ${e.message}`);
    }
  }
  throw new Error('YouTube no devolvió URL');
}

// ================= FALLBACK SOUNDCLOUD =================
async function resolveSoundcloud(query) {
  const safeQ = safeQuery(query);
  try {
    const cmd = `./yt-dlp --no-playlist -f "bestaudio" -g "scsearch1:${safeQ}"`;
    const stdout = await execPromise(cmd);
    const url = stdout.trim();
    if (url) return url;
  } catch (e) {
    console.log('SoundCloud falló:', e.message);
  }
  throw new Error('SoundCloud no devolvió URL');
}

// ================= OBTENER AUDIO (con fallback) =================
async function getAudio(query) {
  try {
    return await resolveYoutube(query);
  } catch (e) {
    console.log('YouTube falló → probando SoundCloud');
    return await resolveSoundcloud(query);
  }
}

// ================= ENDPOINT PRINCIPAL =================
app.get('/audio', async (req, res) => {
  const rawQuery = req.query.q;
  if (!rawQuery) {
    return res.status(400).json({ error: 'Falta el parámetro "q"' });
  }

  const query = normalizeQuery(rawQuery);
  console.log(`🔍 Búsqueda: "${rawQuery}" → "${query}"`);

  // Consultar caché
  const cached = cache.get(query);
  if (cached) {
    console.log(`✔ Cache hit para "${query}"`);
    return res.json({ url: cached.url, cached: true });
  }

  try {
    // Ejecutar con límite de concurrencia
    const url = await limit(() => getAudio(query));
    cache.set(query, { url, timestamp: Date.now() });
    console.log(`🎵 URL obtenida para "${query}"`);
    res.json({ url, cached: false });
  } catch (err) {
    console.error(`❌ Error para "${query}": ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ================= ENDPOINTS DE UTILIDAD =================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheSize: cache.size,
    uptime: process.uptime()
  });
});

app.get('/debug', async (req, res) => {
  try {
    const out = await execPromise('./yt-dlp --version');
    res.send(`yt-dlp versión: ${out}`);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ================= INICIAR SERVIDOR =================
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${port}`);
});
