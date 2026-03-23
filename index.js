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

// Instancias Invidious públicas (rotar si falla)
const INVIDIOUS_INSTANCES = [
  'https://invidious.privacydev.net',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.perennialte.ch',
  'https://yt.cdaut.de',
  'https://invidious.ducks.party',
  'https://invidious.io.lol',
  'https://iv.melmac.space',
];

function safeQ(q)   { return q.replace(/[`$\\;"'<>]/g, ''); }
function md5(s)     { return crypto.createHash('md5').update(s).digest('hex'); }
function isHLS(url) { return !url || url.includes('.m3u8'); }

function run(cmd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(0, 200) || err.message));
      else resolve(stdout.trim());
    });
  });
}

function fetchJson(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON inválido')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchBuffer(url, timeout = 55000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/120.0',
        'Referer': 'https://www.youtube.com/',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} descargando audio`));
        return;
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descarga')); });
  });
}

// ── Buscar video en Invidious ──────────────────────────────────────
async function searchInvidious(query, instance) {
  const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,lengthSeconds`;
  const data = await fetchJson(url, 8000);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Sin resultados');
  // Filtrar lives y videos muy cortos/largos
  const video = data.find(v =>
    v.videoId && v.lengthSeconds > 60 && v.lengthSeconds < 600
  ) || data[0];
  return video.videoId;
}

// ── Obtener URL de audio desde Invidious ─────────────────────────
async function getAudioUrlInvidious(videoId, instance) {
  const url = `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats,formatStreams`;
  const data = await fetchJson(url, 10000);

  // Buscar formato de audio directo (no HLS)
  const formats = [
    ...(data.adaptiveFormats || []),
    ...(data.formatStreams   || []),
  ];

  // Preferir audio/mp4 o audio/webm sin HLS
  const audioFmt = formats
    .filter(f => f.url && !isHLS(f.url) &&
      (f.type?.includes('audio') || f.itag === 140 || f.itag === 251))
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0))[0];

  if (audioFmt?.url) return audioFmt.url;

  // Fallback: cualquier formato con URL directa
  const anyFmt = formats.find(f => f.url && !isHLS(f.url));
  if (anyFmt?.url) return anyFmt.url;

  throw new Error('No hay formato de audio directo');
}

// ── Flujo completo: buscar → URL → buffer → R2 ────────────────────
async function getAudioViaInvidious(query) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`🔍 Buscando en ${instance}...`);
      const videoId = await searchInvidious(query, instance);
      console.log(`🎬 VideoId: ${videoId}`);
      const audioUrl = await getAudioUrlInvidious(videoId, instance);
      console.log(`🎵 URL audio: ${audioUrl.slice(0, 80)}`);
      return { audioUrl, videoId, instance };
    } catch (e) {
      console.log(`⚠️ ${instance}: ${e.message.slice(0, 80)}`);
    }
  }
  throw new Error('Todas las instancias Invidious fallaron');
}

// ── ytdlp como último fallback ────────────────────────────────────
async function getUrlYtdlp(query) {
  const q  = safeQ(query);
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';
  const cmds = [
    `./yt-dlp --no-playlist --no-warnings -f "bestaudio[protocol!=m3u8]" --extractor-args "youtube:player_client=tv_embedded" --user-agent "${ua}" -g "ytsearch1:${q}"`,
    `./yt-dlp --no-playlist --no-warnings -f "bestaudio[protocol!=m3u8]" --user-agent "${ua}" -g "scsearch1:${q}"`,
  ];
  for (const cmd of cmds) {
    try {
      const out = await run(cmd, 15000);
      const url = out.split('\n').find(u => u.startsWith('http') && !isHLS(u));
      if (url) return url;
    } catch (_) {}
  }
  return null;
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

    // 1. Invidious (principal)
    let audioUrl = null;
    let source   = 'invidious';
    let videoId  = '';
    try {
      const res = await getAudioViaInvidious(query);
      audioUrl = res.audioUrl;
      videoId  = res.videoId;
    } catch (e) {
      console.log(`⚠️ Invidious falló: ${e.message} → probando ytdlp`);
    }

    // 2. yt-dlp fallback
    if (!audioUrl) {
      audioUrl = await getUrlYtdlp(query);
      source   = 'ytdlp_direct';
    }

    if (!audioUrl) throw new Error('No se encontró URL de audio por ninguna vía');

    // Descargar buffer
    console.log(`⬇️ Descargando audio...`);
    const buf = await fetchBuffer(audioUrl);
    console.log(`📦 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    if (buf.length < 50000) throw new Error(`Audio demasiado pequeño (${buf.length} bytes)`);

    // Subir a R2
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: r2Key, Body: buf,
      ContentType: 'audio/mpeg', CacheControl: 'public, max-age=2592000',
    }));

    const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
    jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                      youtube_id: videoId, source, title: query, done_at: Date.now() });
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

// /audio — URL directa rápida sin R2 (para Alexa urgente)
app.get('/audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta q' });
  try {
    const { audioUrl, videoId } = await getAudioViaInvidious(q);
    return res.json({ url: audioUrl, source: 'invidious', cached: false });
  } catch (_) {}
  // Fallback ytdlp
  const url = await getUrlYtdlp(q);
  if (url) return res.json({ url, source: 'ytdlp', cached: false });
  res.status(500).json({ error: 'No se encontró URL' });
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', jobs: jobs.size, uptime: Math.floor(process.uptime()) }));

app.get('/debug', async (req, res) => {
  try {
    const ver = await run('./yt-dlp --version', 5000);
    let r2ok = false;
    try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: '_test' })); r2ok = true; }
    catch (e) { r2ok = e.$metadata?.httpStatusCode === 404; }
    res.json({ yt_dlp: ver, node: process.version, r2_configured: !!R2_ACCESS_KEY, r2_ok: r2ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test Invidious
app.get('/debug/invidious', async (req, res) => {
  const q = (req.query.q || 'bohemian rhapsody').trim();
  const results = [];
  for (const inst of INVIDIOUS_INSTANCES.slice(0, 3)) {
    try {
      const vid = await searchInvidious(q, inst);
      const url = await getAudioUrlInvidious(vid, inst);
      results.push({ instance: inst, videoId: vid, url: url.slice(0, 80), ok: true });
      break;
    } catch (e) {
      results.push({ instance: inst, error: e.message, ok: false });
    }
  }
  res.json(results);
});

app.listen(port, () => console.log(`🚀 kimi-audio R2+Invidious en puerto ${port}`));
