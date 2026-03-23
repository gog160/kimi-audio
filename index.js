const express = require('express');
const { exec } = require('child_process');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

const app = express();
app.use(express.json());
const port = process.env.PORT || 10000;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET     = process.env.R2_BUCKET || 'kimi-audio';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-59e0ffd74fc64fbfaf28a41cf7e8409a.r2.dev';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});

const jobs = new Map();

const USER_AGENTS = [
  'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
  'com.google.android.youtube/17.31.35 (Linux; U; Android 12) gzip',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/112.0 Mobile Safari/537.36',
];

function safeQ(q)   { return q.replace(/[`$\\;"'<>]/g, ''); }
function md5(s)     { return crypto.createHash('md5').update(s).digest('hex'); }
function isHLS(url) { return !url || url.includes('.m3u8'); }
function randUA()   { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

function run(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(0, 300) || err.message));
      else resolve(stdout.trim());
    });
  });
}

function fetchBuffer(url, timeout = 55000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proto  = url.startsWith('https') ? https : http;
    const req    = proto.get(url, {
      headers: {
        'User-Agent': randUA(),
        'Referer':    'https://www.youtube.com/',
        'Origin':     'https://www.youtube.com',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Estrategias para obtener URL directa ─────────────────────────
async function getDirectUrl(query) {
  const q  = safeQ(query);
  const ua = randUA();

  const strategies = [
    // 1. YouTube cliente android (evita bot-check en 2026)
    {
      name: 'yt_android',
      cmd: `./yt-dlp --no-playlist --no-warnings \
        -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" \
        --extractor-args "youtube:player_client=android" \
        --user-agent "${ua}" \
        --sleep-interval 2 --max-sleep-interval 5 \
        --no-check-certificate \
        -g "ytsearch1:${q}"`,
    },
    // 2. YouTube cliente android_music
    {
      name: 'yt_android_music',
      cmd: `./yt-dlp --no-playlist --no-warnings \
        -f "bestaudio" \
        --extractor-args "youtube:player_client=android_music" \
        --user-agent "${ua}" \
        --sleep-interval 2 \
        --no-check-certificate \
        -g "ytsearch1:${q}"`,
    },
    // 3. YouTube cliente mweb
    {
      name: 'yt_mweb',
      cmd: `./yt-dlp --no-playlist --no-warnings \
        -f "bestaudio[protocol!=m3u8]" \
        --extractor-args "youtube:player_client=mweb" \
        --user-agent "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36" \
        -g "ytsearch1:${q}"`,
    },
    // 4. SoundCloud con device_id aleatorio
    {
      name: 'soundcloud',
      cmd: `./yt-dlp --no-playlist --no-warnings \
        -f "bestaudio[ext=mp3]/bestaudio[protocol!=m3u8]" \
        --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0" \
        -g "scsearch1:${q}"`,
    },
  ];

  for (const s of strategies) {
    try {
      await sleep(1000 + Math.random() * 2000); // pausa anti-bot
      const out  = await run(s.cmd, 25000);
      const urls = out.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
      const url  = urls.find(u => !isHLS(u));
      if (url) {
        console.log(`✅ [${s.name}] URL obtenida: ${url.slice(0, 70)}`);
        return { url, source: s.name };
      }
    } catch (e) {
      console.log(`⚠️ [${s.name}]: ${e.message.slice(0, 100)}`);
    }
  }
  throw new Error('Todas las estrategias fallaron');
}

// ── Procesar job ──────────────────────────────────────────────────
async function processJob(jobId, query) {
  jobs.set(jobId, { status: 'processing', query, created_at: Date.now() });
  const hash  = md5(query.toLowerCase().trim());
  const r2Key = `songs/${hash}.mp3`;

  try {
    // ¿Ya en R2?
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
      jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                        source: 'r2_existing', done_at: Date.now() });
      console.log(`✅ Ya en R2: ${r2Key}`);
      return;
    } catch (_) {}

    // Obtener URL directa
    const { url: audioUrl, source } = await getDirectUrl(query);

    // Descargar buffer
    console.log(`⬇️ Descargando...`);
    const buf = await fetchBuffer(audioUrl);
    console.log(`📦 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    if (buf.length < 50000) throw new Error(`Audio demasiado pequeño: ${buf.length} bytes`);

    // Subir a R2
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: r2Key, Body: buf,
      ContentType: 'audio/mpeg', CacheControl: 'public, max-age=2592000',
    }));

    const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
    jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                      source, title: query, done_at: Date.now() });
    console.log(`✅ Listo: ${jobId} → ${r2Url}`);

  } catch (e) {
    jobs.set(jobId, { status: 'failed', query, error: e.message, done_at: Date.now() });
    console.error(`❌ ${jobId} falló: ${e.message}`);
  }
}

// Limpiar jobs >2h
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, j] of jobs) if (j.created_at < cutoff) jobs.delete(id);
}, 3600000);

// ── Endpoints ─────────────────────────────────────────────────────

app.post('/process', (req, res) => {
  const { query, youtube_id, job_id } = req.body;
  if (!query && !youtube_id) return res.status(400).json({ error: 'Falta query' });
  const jobId = job_id || crypto.randomUUID().slice(0, 8);
  res.json({ job_id: jobId, status: 'processing' });
  processJob(jobId, query || youtube_id);
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// /audio — URL directa sin R2 para Alexa urgente
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

// /precache — batch nocturno (lista de canciones)
app.post('/precache', async (req, res) => {
  const { songs = [], batch_id } = req.body;
  if (!songs.length) return res.status(400).json({ error: 'Lista vacía' });
  const batchId = batch_id || crypto.randomUUID().slice(0, 8);
  const jobIds  = songs.map((s, i) => {
    const jobId = `${batchId}_${i}`;
    setTimeout(() => processJob(jobId, s), i * 8000); // espaciar 8s entre jobs
    return { song: s, job_id: jobId };
  });
  res.json({ batch_id: batchId, total: songs.length, jobs: jobIds });
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', jobs: jobs.size, uptime: Math.floor(process.uptime()) }));

app.get('/debug', async (req, res) => {
  try {
    const ver = await run('./yt-dlp --version', 5000);
    let r2ok  = false;
    try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: '_test' })); r2ok = true; }
    catch (e) { r2ok = e.$metadata?.httpStatusCode === 404; }
    res.json({ yt_dlp: ver, node: process.version, r2_configured: !!R2_ACCESS_KEY, r2_ok: r2ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test rápido de una estrategia
app.get('/debug/strategy', async (req, res) => {
  const q = (req.query.q || 'bohemian rhapsody queen').trim();
  try {
    const result = await getDirectUrl(q);
    res.json({ ok: true, url: result.url.slice(0, 100), source: result.source });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(port, () => console.log(`🚀 kimi-audio android+R2 en puerto ${port}`));
