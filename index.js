const express = require('express');
const { exec } = require('child_process');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const port = process.env.PORT || 10000;

// ================= R2 CONFIG =================
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

// ================= CONFIG =================
const TIMEOUT_DL = 55000;
const TMP_DIR    = '/tmp/kimi_audio';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();

// ================= HELPERS =================
function safeQ(q)   { return q.replace(/[`$\\;"']/g, ''); }
function md5(s)     { return crypto.createHash('md5').update(s).digest('hex'); }
function isHLS(url) { return !url || url.includes('.m3u8'); }
function randomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

function run(cmd, timeout = TIMEOUT_DL) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.slice(0, 200) || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ================= DESCARGA (SoundCloud primero, YouTube fallback) =================
async function downloadToFile(query, outPath) {
  const q   = safeQ(query);
  const ua  = randomUA();

  // 1. SoundCloud — más fiable en Render (no bloquea IPs de servidores)
  const scFormats = [
    'bestaudio[ext=mp3]',
    'bestaudio[protocol!=m3u8][protocol!=m3u8_native]',
    'bestaudio',
  ];
  for (const fmt of scFormats) {
    try {
      await run(`./yt-dlp --no-playlist -f "${fmt}" \
        --no-warnings --user-agent "${ua}" \
        -x --audio-format mp3 --audio-quality 128K \
        -o "${outPath}" "scsearch1:${q}"`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
        console.log(`✅ SoundCloud (${fmt}): ${query}`);
        return 'soundcloud';
      }
    } catch (e) {
      console.log(`SC ${fmt}: ${e.message.slice(0,80)}`);
    }
  }

  // 2. YouTube — intentar con distintos clientes
  const ytClients = ['tv_embedded', 'tv', 'web_creator', 'mweb'];
  for (const client of ytClients) {
    try {
      await run(`./yt-dlp --no-playlist \
        -f "bestaudio[ext=m4a]/bestaudio" \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}" --geo-bypass --no-warnings \
        -x --audio-format mp3 --audio-quality 128K \
        -o "${outPath}" "ytsearch1:${q}"`);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
        console.log(`✅ YouTube (${client}): ${query}`);
        return `youtube_${client}`;
      }
    } catch (e) {
      console.log(`YT ${client}: ${e.message.slice(0,80)}`);
    }
  }

  throw new Error('No se pudo descargar de SoundCloud ni YouTube');
}

// ================= SUBIR A R2 =================
async function uploadR2(localPath, r2Key) {
  const buf = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: r2Key, Body: buf,
    ContentType: 'audio/mpeg', CacheControl: 'public, max-age=2592000',
  }));
  return `${R2_PUBLIC_URL}/${r2Key}`;
}

// ================= PROCESAR JOB =================
async function processJob(jobId, query, youtubeId) {
  jobs.set(jobId, { status: 'processing', query, created_at: Date.now() });
  const hash   = md5(youtubeId || query);
  const r2Key  = `songs/${hash}.mp3`;
  const tmpFile= path.join(TMP_DIR, `${hash}.mp3`);

  try {
    // ¿Ya existe en R2?
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
      jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                        youtube_id: youtubeId || '', source: 'r2_existing', done_at: Date.now() });
      console.log(`✅ Ya en R2: ${r2Key}`);
      return;
    } catch (_) {}

    // Descargar
    const source = await downloadToFile(youtubeId || query, tmpFile);

    // Subir a R2
    const r2Url = await uploadR2(tmpFile, r2Key);
    try { fs.unlinkSync(tmpFile); } catch (_) {}

    jobs.set(jobId, { status: 'ready', query, r2_key: r2Key, r2_url: r2Url,
                      youtube_id: youtubeId || '', source, title: query, done_at: Date.now() });
    console.log(`✅ Job listo: ${jobId} → ${r2Url}`);

  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    jobs.set(jobId, { status: 'failed', query, error: e.message, done_at: Date.now() });
    console.error(`❌ Job ${jobId} falló: ${e.message}`);
  }
}

// Limpiar jobs >2h
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600000;
  for (const [id, j] of jobs) if (j.created_at < cutoff) jobs.delete(id);
}, 3600000);

// ================= ENDPOINTS =================

// POST /process — job async
app.post('/process', (req, res) => {
  const { query, youtube_id, job_id } = req.body;
  if (!query && !youtube_id) return res.status(400).json({ error: 'Falta query' });
  const jobId = job_id || crypto.randomUUID().slice(0, 8);
  res.json({ job_id: jobId, status: 'processing' });
  processJob(jobId, query || youtube_id, youtube_id || '');
});

// GET /status/:jobId — polling
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// GET /audio — URL directa rápida (fallback para Alexa sin R2)
app.get('/audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Falta q' });
  const safe = safeQ(q.toLowerCase());
  // SoundCloud directo (sin descargar)
  try {
    const url = await run(`./yt-dlp --no-playlist --no-warnings \
      -f "bestaudio[ext=mp3]/bestaudio[protocol!=m3u8]" \
      -g "scsearch1:${safe}"`, 18000);
    if (url && url.startsWith('http') && !isHLS(url))
      return res.json({ url, source: 'soundcloud_direct', cached: false });
  } catch (_) {}
  // YouTube directo fallback
  try {
    const url = await run(`./yt-dlp --no-playlist --no-warnings \
      -f "bestaudio[protocol!=m3u8]" \
      --extractor-args "youtube:player_client=tv_embedded" \
      -g "ytsearch1:${safe}"`, 18000);
    if (url && url.startsWith('http') && !isHLS(url))
      return res.json({ url, source: 'youtube_direct', cached: false });
  } catch (_) {}
  res.status(500).json({ error: 'No se encontró URL directa' });
});

// GET /health
app.get('/health', (req, res) =>
  res.json({ status: 'ok', jobs: jobs.size, uptime: Math.floor(process.uptime()) }));

// GET /debug
app.get('/debug', async (req, res) => {
  try {
    const ver = await run('./yt-dlp --version', 5000);
    // Test R2
    let r2ok = false;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: 'test' }));
      r2ok = true;
    } catch (e) {
      r2ok = e.name !== 'CredentialsProviderError';
    }
    res.json({ yt_dlp: ver, node: process.version, r2_configured: !!R2_ACCESS_KEY, r2_ok: r2ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`🚀 kimi-audio R2 en puerto ${port}`));
