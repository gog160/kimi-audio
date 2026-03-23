const express = require('express');
const { exec } = require('child_process');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const https = require('https');
const http  = require('http');

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

function safeQ(q)   { return q.replace(/[`$\\;"']/g, ''); }
function md5(s)     { return crypto.createHash('md5').update(s).digest('hex'); }
function isHLS(url) { return !url || url.includes('.m3u8'); }

function run(cmd, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(0,300) || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Obtener URL directa MP3 (sin descargar)
async function getDirectUrl(query) {
  const q = safeQ(query);
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';

  // Intentar varias fuentes para obtener URL directa
  const attempts = [
    `./yt-dlp --no-playlist --no-warnings -f "bestaudio[ext=mp3]/bestaudio[protocol!=m3u8]" --user-agent "${ua}" -g "scsearch1:${q}"`,
    `./yt-dlp --no-playlist --no-warnings -f "bestaudio[protocol!=m3u8]" --extractor-args "youtube:player_client=tv_embedded" --user-agent "${ua}" -g "ytsearch1:${q}"`,
    `./yt-dlp --no-playlist --no-warnings -f "bestaudio[protocol!=m3u8]" --extractor-args "youtube:player_client=tv" --user-agent "${ua}" -g "ytsearch1:${q}"`,
    `./yt-dlp --no-playlist --no-warnings --user-agent "${ua}" -g "scsearch1:${q}"`,
  ];

  for (const cmd of attempts) {
    try {
      const out = await run(cmd, 18000);
      // Puede devolver múltiples URLs — coger la primera no-HLS
      const urls = out.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
      const direct = urls.find(u => !isHLS(u));
      if (direct) {
        console.log(`✅ URL directa: ${direct.slice(0,60)}`);
        return direct;
      }
    } catch (e) {
      console.log(`Intento fallido: ${e.message.slice(0,80)}`);
    }
  }
  throw new Error('No se encontró URL directa de audio');
}

// Descargar URL a buffer y subir a R2
function fetchToBuffer(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'Referer': 'https://soundcloud.com/',
      },
      timeout: 50000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Seguir redirección
        fetchToBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descargando audio')); });
  });
}

async function processJob(jobId, query) {
  jobs.set(jobId, { status: 'processing', query, created_at: Date.now() });
  const hash  = md5(query.toLowerCase().trim());
  const r2Key = `songs/${hash}.mp3`;

  try {
    // ¿Ya existe en R2?
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
      jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                        source: 'r2_existing', done_at: Date.now() });
      console.log(`✅ Ya en R2: ${r2Key}`);
      return;
    } catch (_) {}

    // Obtener URL directa
    const directUrl = await getDirectUrl(query);

    // Descargar a buffer
    console.log(`⬇️ Descargando buffer...`);
    const audioBuffer = await fetchToBuffer(directUrl);
    console.log(`📦 Buffer: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

    if (audioBuffer.length < 50000) {
      throw new Error(`Archivo demasiado pequeño (${audioBuffer.length} bytes)`);
    }

    // Subir a R2
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: r2Key, Body: audioBuffer,
      ContentType: 'audio/mpeg', CacheControl: 'public, max-age=2592000',
    }));

    const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
    jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                      source: 'soundcloud', title: query, done_at: Date.now() });
    console.log(`✅ Job listo: ${jobId} → ${r2Url}`);

  } catch (e) {
    jobs.set(jobId, { status: 'failed', query, error: e.message, done_at: Date.now() });
    console.error(`❌ Job ${jobId} falló: ${e.message}`);
  }
}

// Limpiar jobs >2h
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, j] of jobs) if (j.created_at < cutoff) jobs.delete(id);
}, 3600000);

// POST /process
app.post('/process', (req, res) => {
  const { query, youtube_id, job_id } = req.body;
  if (!query && !youtube_id) return res.status(400).json({ error: 'Falta query' });
  const jobId = job_id || crypto.randomUUID().slice(0, 8);
  res.json({ job_id: jobId, status: 'processing' });
  processJob(jobId, query || youtube_id);
});

// GET /status/:jobId
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// GET /audio — URL directa rápida (sin R2, para Alexa urgente)
app.get('/audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta q' });
  try {
    const url = await getDirectUrl(q);
    res.json({ url, source: 'direct', cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /health
app.get('/health', (req, res) =>
  res.json({ status: 'ok', jobs: jobs.size, uptime: Math.floor(process.uptime()) }));

// GET /debug
app.get('/debug', async (req, res) => {
  try {
    const ver = await run('./yt-dlp --version', 5000);
    let r2ok = false;
    try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: '_test' })); r2ok = true; }
    catch (e) { r2ok = e.$metadata?.httpStatusCode === 404; }
    res.json({ yt_dlp: ver, node: process.version, r2_configured: !!R2_ACCESS_KEY, r2_ok: r2ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => console.log(`🚀 kimi-audio R2 en puerto ${port}`));
