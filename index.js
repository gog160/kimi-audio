// kimi-audio v4 – Render Music Service
// Estrategias: android/android_music/mweb + Piped validado + SoundCloud
// Sin ffmpeg: formato forzado m4a/mp3 desde yt-dlp
// R2 persistente + PostgreSQL para cola + Telegram notificación

import express  from 'express';
import { exec } from 'child_process';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto   from 'crypto';
import https    from 'https';
import http     from 'http';
import pg       from 'pg';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app  = express();
app.use(express.json());
const port = process.env.PORT || 10000;

// ====================== CONFIG ======================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET     = process.env.R2_BUCKET     || 'kimi-audio';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-59e0ffd74fc64fbfaf28a41cf7e8409a.r2.dev';
const TG_TOKEN      = process.env.TELEGRAM_TOKEN;
const ADMIN_CHAT    = process.env.ADMIN_CHAT_ID;
const MAX_JOBS      = 1;   // Free tier: 1 job = máx ~20MB RAM pico
let   activeJobs    = 0;

// ====================== R2 ======================
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

// ====================== POSTGRESQL ======================
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS url_cache (
      query_hash TEXT PRIMARY KEY,
      r2_url     TEXT,
      source     TEXT,
      ts         BIGINT
    );
    CREATE TABLE IF NOT EXISTS queue (
      id         SERIAL PRIMARY KEY,
      query      TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      status     TEXT DEFAULT 'pending',
      retries    INTEGER DEFAULT 0,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())*1000
    );
  `);
  console.log('✅ BD inicializada');
}
initDB().catch(e => console.error('DB init error:', e.message));

// ====================== TELEGRAM ======================
async function tgSend(chatId, text) {
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal:  AbortSignal.timeout(8000),
    });
  } catch (e) { console.warn('TG error:', e.message); }
}

// ====================== HELPERS ======================
function md5(s)    { return crypto.createHash('md5').update(s).digest('hex'); }
function safeQ(q)  { return q.replace(/[`$\\;"'<>]/g, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const USER_AGENTS = [
  'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  'com.google.android.youtube/17.31.35 (Linux; U; Android 12) gzip',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36',
];
function randUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function run(cmd, timeout = 28000) {
  return execAsync(cmd, { timeout }).then(r => r.stdout.trim());
}

// Validación estricta de URL de audio (Alexa compatible)
function isValidAudioUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  if (url.includes('.m3u8'))   return false;  // HLS → Alexa no acepta
  if (url.includes('manifest')) return false; // fragmentado
  // Formatos aceptados por Alexa
  const ok = url.includes('.mp3') || url.includes('.m4a') ||
             url.includes('.aac') || url.includes('mime=audio') ||
             url.includes('googlevideo.com') ||  // YouTube directo
             url.includes('sndcdn.com');          // SoundCloud directo
  return ok;
}

// ====================== PIPED (instancias actualizadas) ======================
let pipedInstances = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpup.dev',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
];
const pipedHealth = new Map();

async function updatePipedInstances() {
  try {
    const r = await fetch('https://piped-instances.kavin.rocks/', {
      signal: AbortSignal.timeout(6000)
    });
    if (r.ok) {
      const list = await r.json();
      const urls = list.map(i => i.api_url).filter(u => u?.startsWith('https'));
      if (urls.length > 3) {
        pipedInstances = urls.slice(0, 10);
        console.log(`🔄 Piped: ${pipedInstances.length} instancias actualizadas`);
      }
    }
  } catch (_) {}
}
updatePipedInstances();
setInterval(updatePipedInstances, 12 * 3600000);

// ====================== ESTRATEGIAS ANTI-BLOQUEO ======================
async function getDirectUrl(query) {
  const q  = safeQ(query);
  const ua = randUA();

  // Formato seguro para Alexa: m4a o mp3, sin HLS, bitrate limitado
  const YT_FORMAT = '"bestaudio[ext=m4a][abr<=160]/bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[ext=webm][protocol!=m3u8]"';

  const strategies = [

    // 1. Android client — mejor anti-bot en 2026
    {
      name: 'yt_android',
      run: async () => {
        const out = await run(
          `./yt-dlp --no-playlist --no-warnings \
          -f ${YT_FORMAT} \
          --extractor-args "youtube:player_client=android" \
          --user-agent "${ua}" \
          --sleep-interval 1 --max-sleep-interval 3 \
          --no-check-certificate \
          -g "ytsearch1:${q}"`,
          28000
        );
        return out.split('\n').find(u => isValidAudioUrl(u));
      },
    },

    // 2. Android Music client
    {
      name: 'yt_android_music',
      run: async () => {
        const out = await run(
          `./yt-dlp --no-playlist --no-warnings \
          -f ${YT_FORMAT} \
          --extractor-args "youtube:player_client=android_music" \
          --user-agent "${ua}" \
          --sleep-interval 1 \
          --no-check-certificate \
          -g "ytsearch1:${q}"`,
          25000
        );
        return out.split('\n').find(u => isValidAudioUrl(u));
      },
    },

    // 3. mweb client
    {
      name: 'yt_mweb',
      run: async () => {
        const out = await run(
          `./yt-dlp --no-playlist --no-warnings \
          -f ${YT_FORMAT} \
          --extractor-args "youtube:player_client=mweb" \
          --user-agent "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36" \
          -g "ytsearch1:${q}"`,
          22000
        );
        return out.split('\n').find(u => isValidAudioUrl(u));
      },
    },

    // 4. Piped API — proxy YouTube, sin yt-dlp, pero validación estricta
    {
      name: 'piped',
      run: async () => {
        for (const inst of pipedInstances.slice(0, 6)) {
          if (pipedHealth.get(inst) === false) continue;
          try {
            // Buscar video ID
            const sr = await fetch(
              `${inst}/search?q=${encodeURIComponent(query)}&filter=music_songs`,
              { signal: AbortSignal.timeout(6000) }
            );
            if (!sr.ok) { pipedHealth.set(inst, false); continue; }
            const sd  = await sr.json();
            const vid = sd.items?.[0]?.url?.split('watch?v=')?.[1]?.split('&')?.[0];
            if (!vid) continue;

            // Obtener streams del video
            const vr = await fetch(`${inst}/streams/${vid}`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (!vr.ok) continue;
            const vd = await vr.json();

            // Filtrar audio válido: preferir m4a/mp3, excluir HLS y fragmentados
            const best = (vd.audioStreams || [])
              .filter(s => isValidAudioUrl(s.url) &&
                           (s.mimeType?.includes('audio/mp4') ||
                            s.mimeType?.includes('audio/mpeg') ||
                            s.codec?.includes('mp4a')))
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

            if (best?.url) {
              pipedHealth.set(inst, true);
              return best.url;
            }
          } catch (e) {
            pipedHealth.set(inst, false);
          }
        }
        return null;
      },
    },

    // 5. SoundCloud — mp3 directo, sin problemas de bot
    {
      name: 'soundcloud',
      run: async () => {
        const out = await run(
          `./yt-dlp --no-playlist --no-warnings \
          -f "bestaudio[ext=mp3]/bestaudio[protocol!=m3u8][protocol!=m3u8_native]" \
          --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" \
          -g "scsearch1:${q}"`,
          20000
        );
        return out.split('\n').find(u => isValidAudioUrl(u));
      },
    },

  ];

  for (const s of strategies) {
    try {
      await sleep(500 + Math.random() * 1000);
      const url = await s.run();
      if (url) {
        console.log(`✅ [${s.name}] ${url.slice(0, 70)}`);
        return { url, source: s.name };
      }
      console.log(`⚠️ [${s.name}] sin URL válida`);
    } catch (e) {
      console.log(`⚠️ [${s.name}] ${e.message.slice(0, 80)}`);
    }
  }
  throw new Error('Todas las estrategias fallaron');
}

// ====================== DESCARGA CON LÍMITE DE TAMAÑO ======================
// PUNTO 2: Descarga con límite de tamaño DURANTE el stream (aborta antes de agotar RAM)
function downloadBufferLimited(url, maxSizeMB = 30, timeout = 55000) {
  const maxBytes = maxSizeMB * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': randUA(),
        'Referer':    'https://www.youtube.com/',
        'Origin':     'https://www.youtube.com',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBufferLimited(res.headers.location, maxSizeMB, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} al descargar audio`));
        return;
      }
      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          chunks.length = 0;  // Liberar memoria inmediatamente
          reject(new Error(`Archivo supera ${maxSizeMB} MB (${(totalBytes/1024/1024).toFixed(1)} MB)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        chunks.length = 0;  // Liberar array de chunks
        resolve(buf);
      });
      res.on('error', (err) => {
        chunks.length = 0;  // Liberar en error
        reject(err);
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descarga')); });
  });
}

// ====================== DETECTAR EXTENSIÓN REAL ======================
function detectExtension(url) {
  const extMatch = url.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase();
    if (['mp3', 'm4a', 'aac'].includes(ext)) return ext;
  }
  if (url.includes('mime=audio%2Fmpeg') || url.includes('mime=audio/mpeg')) return 'mp3';
  if (url.includes('mime=audio%2Fmp4')  || url.includes('mime=audio/mp4'))  return 'm4a';
  return 'mp3'; // fallback seguro para Alexa
}
function extToContentType(ext) {
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  return 'audio/mpeg';
}

// ====================== PROCESAR JOB ======================
async function processJob(query, chatId) {
  const hash  = md5(query.toLowerCase().trim());
  const r2Key = `songs/${hash}.mp3`; // placeholder, se recalcula abajo con ext real

  // ¿Ya en R2? Buscar con ambas extensiones posibles
  for (const tryExt of ['mp3', 'm4a', 'aac']) {
    const tryKey = `songs/${hash}.${tryExt}`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: tryKey }));
      const r2Url = `${R2_PUBLIC_URL}/${tryKey}`;
      await pool.query(
        `INSERT INTO url_cache VALUES ($1,$2,$3,$4)
         ON CONFLICT (query_hash) DO UPDATE SET r2_url=$2, ts=$4`,
        [hash, r2Url, 'r2_existing', Date.now()]
      );
      await tgSend(chatId, `✅ *${query}* ya estaba lista.\nURL: ${r2Url}\nDi a Alexa: _pon ${query}_`);
      return r2Url;
    } catch (_) {}
  }

  // Obtener URL directa
  const { url: audioUrl, source } = await getDirectUrl(query);

  // PUNTO 2: Descargar con límite de tamaño durante el stream (no después)
  console.log(`⬇️ Descargando ${query}...`);
  const buf = await downloadBufferLimited(audioUrl, 20);
  console.log(`📦 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  if (buf.length < 50000)
    throw new Error(`Archivo demasiado pequeño: ${buf.length} bytes`);

  // PUNTO 1: Detectar extensión real desde la URL
  const finalExt  = detectExtension(audioUrl);
  const finalKey  = `songs/${hash}.${finalExt}`;
  const contentType = extToContentType(finalExt);

  // Subir a R2 con extensión correcta
  await s3.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         finalKey,
    Body:        buf,
    ContentType: contentType,
    CacheControl:'public, max-age=2592000',
  }));
  const r2Url = `${R2_PUBLIC_URL}/${finalKey}`;

  // Guardar en PostgreSQL
  await pool.query(
    `INSERT INTO url_cache VALUES ($1,$2,$3,$4)
     ON CONFLICT (query_hash) DO UPDATE SET r2_url=$2, source=$3, ts=$4`,
    [hash, r2Url, source, Date.now()]
  );

  // Notificar por Telegram — INCLUYE URL para que Kimi la capture y cachée localmente
  await tgSend(chatId,
    `🎵 *${query}* lista.\nURL: ${r2Url}\nFuente: \`${source}\` | _Di a Alexa: pon ${query}_`
  );
  if (ADMIN_CHAT && ADMIN_CHAT !== String(chatId)) {
    await tgSend(ADMIN_CHAT, `🎵 Procesado: "${query}" → \`${source}\``);
  }

  return r2Url;
}

// ====================== WORKER ======================
async function runWorker() {
  if (activeJobs >= MAX_JOBS) return;
  let task;
  try {
    const res = await pool.query(
      `SELECT id, query, chat_id, retries FROM queue
       WHERE status='pending' ORDER BY created_at ASC LIMIT 1`
    );
    task = res.rows[0];
    if (!task) return;
    await pool.query(`UPDATE queue SET status='processing' WHERE id=$1`, [task.id]);
  } catch (e) { console.error('Worker query error:', e.message); return; }

  activeJobs++;
  try {
    await processJob(task.query, task.chat_id);
    await pool.query(`DELETE FROM queue WHERE id=$1`, [task.id]);
    console.log(`✅ Job OK: ${task.query}`);
  } catch (err) {
    console.error(`❌ Job ${task.id} falló: ${err.message}`);
    const retries = task.retries + 1;
    if (retries < 3) {
      await pool.query(
        `UPDATE queue SET status='pending', retries=$1 WHERE id=$2`,
        [retries, task.id]
      );
      console.log(`🔄 Reintento ${retries}/3 para: ${task.query}`);
    } else {
      await pool.query(`DELETE FROM queue WHERE id=$1`, [task.id]);
      await tgSend(task.chat_id,
        `❌ No pude conseguir *${task.query}* tras 3 intentos.`
      );
    }
  }
  activeJobs--;
}
// ====================== MONITOR DE MEMORIA ======================
const RAM_WARN_MB  = 350;  // Avisar en log
const RAM_PAUSE_MB = 430;  // Pausar nuevos jobs (límite Render free ~512MB)

function getRamMB() {
  return process.memoryUsage().rss / 1024 / 1024;
}

function checkMemory() {
  const ram = getRamMB();
  if (ram > RAM_PAUSE_MB) {
    console.error(`🚨 RAM CRÍTICA: ${ram.toFixed(0)}MB — pausando jobs y forzando GC`);
    // Forzar GC si está disponible (node --expose-gc)
    if (global.gc) global.gc();
  } else if (ram > RAM_WARN_MB) {
    console.warn(`⚠️ RAM alta: ${ram.toFixed(0)}MB`);
    if (global.gc) global.gc();
  }
  return ram;
}
setInterval(checkMemory, 30000);  // Revisar cada 30s

// Worker con protección RAM
async function runWorkerSafe() {
  const ram = getRamMB();
  if (ram > RAM_PAUSE_MB) {
    console.warn(`⏸️ Worker pausado por RAM: ${ram.toFixed(0)}MB`);
    return;
  }
  await runWorker();
}
setInterval(runWorkerSafe, 5000);

// ====================== ENDPOINTS ======================

// POST /precache — Pi encola canción, responde inmediato
app.post('/precache', async (req, res) => {
  const { query, chatId } = req.body;
  if (!query || !chatId) return res.status(400).json({ error: 'Falta query o chatId' });

  const hash = md5(query.toLowerCase().trim());
  try {
    const cached = await pool.query(
      `SELECT r2_url FROM url_cache WHERE query_hash=$1`, [hash]
    );
    if (cached.rows.length) {
      return res.json({ status: 'ready', url: cached.rows[0].r2_url, source: 'cache' });
    }
    await pool.query(
      `INSERT INTO queue (query, chat_id) VALUES ($1, $2)`,
      [query, chatId]
    );
    res.json({ status: 'accepted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /get — Pi consulta si ya está lista
app.get('/get', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });
  const hash = md5(q.toLowerCase().trim());
  try {
    const r = await pool.query(
      `SELECT r2_url, source FROM url_cache WHERE query_hash=$1`, [hash]
    );
    if (r.rows.length) return res.json({ url: r.rows[0].r2_url, source: r.rows[0].source });
    res.status(404).json({ error: 'not in cache' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /audio — URL directa rápida para Alexa (sin R2, fallback urgente)
app.get('/audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta q' });
  try {
    const { url, source } = await getDirectUrl(q);
    res.json({ url, source, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /memory — estado RAM
app.get('/memory', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    rss_mb:      (mem.rss      / 1024 / 1024).toFixed(1),
    heap_mb:     (mem.heapUsed / 1024 / 1024).toFixed(1),
    heap_max_mb: (mem.heapTotal/ 1024 / 1024).toFixed(1),
    active_jobs: activeJobs,
    warn_at_mb:  RAM_WARN_MB,
    pause_at_mb: RAM_PAUSE_MB,
  });
});

// GET /health
app.get('/health', (req, res) =>
  res.json({ status: 'ok', jobs: activeJobs, uptime: Math.floor(process.uptime()) })
);

// GET /debug
app.get('/debug', async (req, res) => {
  try {
    const ver  = await run('./yt-dlp --version', 5000);
    let r2ok   = false;
    try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: '_test' })); r2ok = true; }
    catch (e) { r2ok = e.$metadata?.httpStatusCode === 404; }
    const db   = await pool.query('SELECT COUNT(*) FROM url_cache');
    const q    = await pool.query("SELECT COUNT(*) FROM queue WHERE status='pending'");
    res.json({
      yt_dlp:          ver,
      node:            process.version,
      r2_ok:           r2ok,
      cache_entries:   parseInt(db.rows[0].count),
      queue_pending:   parseInt(q.rows[0].count),
      piped_instances: pipedInstances.length,
      active_jobs:     activeJobs,
      ram_mb:          getRamMB().toFixed(1),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /debug/strategy — probar estrategias sin subir a R2
app.get('/debug/strategy', async (req, res) => {
  const q = (req.query.q || 'bohemian rhapsody queen').trim();
  try {
    const result = await getDirectUrl(q);
    res.json({ ok: true, url: result.url.slice(0, 120), source: result.source });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(port, () => console.log(`🚀 kimi-audio v4 en puerto ${port}`));
