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
const R2_ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY  = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY  = process.env.R2_SECRET_KEY;
const R2_BUCKET      = process.env.R2_BUCKET || 'kimi-audio';
const R2_PUBLIC_URL  = process.env.R2_PUBLIC_URL || 'https://pub-59e0ffd74fc64fbfaf28a41cf7e8409a.r2.dev';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// ================= CONFIG =================
const TIMEOUT_SEARCH = 20000;
const TIMEOUT_DL     = 120000;  // 2 min para descarga completa
const MAX_CONCURRENT = 2;
const TMP_DIR        = '/tmp/kimi_audio';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
];

// Jobs en memoria (Render es stateless — Pi guarda la verdad)
const jobs = new Map();  // jobId → { status, r2_key, url, error, youtube_id }
let activeJobs = 0;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ================= HELPERS =================
function safeQuery(q) { return q.replace(/[`$\\;"'<>|&]/g, ''); }
function randomUA()   { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function md5(str)     { return crypto.createHash('md5').update(str).digest('hex'); }

function execPromise(cmd, timeout = TIMEOUT_SEARCH) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function isHLS(url) {
  return !url || url.includes('.m3u8') || url.includes('playlist.m3u8');
}

// ================= BUSCAR YOUTUBE ID =================
async function findYoutubeId(query) {
  const safeQ = safeQuery(query);
  const ua    = randomUA();
  const YT_CLIENTS = ['tv_embedded', 'tv', 'web_safari', 'web'];

  for (const client of YT_CLIENTS) {
    try {
      const cmd = `./yt-dlp --no-playlist \
        --extractor-args "youtube:player_client=${client}" \
        --user-agent "${ua}" \
        --match-filter "!is_live" \
        --no-warnings \
        --get-id "ytsearch1:${safeQ}"`;
      const ytId = await execPromise(cmd, TIMEOUT_SEARCH);
      if (ytId && ytId.length === 11) {
        console.log(`✅ YouTube ID (${client}): ${ytId} para "${query}"`);
        return ytId;
      }
    } catch (e) {
      console.log(`YouTube ${client} falló: ${e.message.slice(0, 60)}`);
    }
  }

  // Fallback: SoundCloud — devolver URL directa en lugar de ID
  try {
    const cmd = `./yt-dlp --no-playlist --no-warnings \
      -f "bestaudio[ext=mp3]/bestaudio[protocol!=m3u8]" \
      -g "scsearch1:${safeQ}"`;
    const url = await execPromise(cmd, TIMEOUT_SEARCH);
    if (url && url.startsWith('http') && !isHLS(url)) {
      return { type: 'direct_url', url, source: 'soundcloud' };
    }
  } catch (e) {}

  throw new Error('No se encontró la canción en YouTube ni SoundCloud');
}

// ================= DESCARGAR Y SUBIR A R2 =================
async function downloadAndUpload(youtubeIdOrObj, jobId) {
  const tmpFile = path.join(TMP_DIR, `${jobId}.mp3`);

  try {
    let r2Key, publicUrl, source;

    if (typeof youtubeIdOrObj === 'object' && youtubeIdOrObj.type === 'direct_url') {
      // SoundCloud URL directa — descargar con wget
      const { url, source: src } = youtubeIdOrObj;
      source = src;
      r2Key  = `songs/${md5(url)}.mp3`;

      console.log(`⬇️ Descargando SoundCloud directo...`);
      await execPromise(`wget -q -O "${tmpFile}" "${url}"`, TIMEOUT_DL);

    } else {
      // YouTube ID — descargar con yt-dlp
      const ytId = youtubeIdOrObj;
      source = 'youtube';
      r2Key  = `songs/${md5(ytId)}.mp3`;

      // Comprobar si ya existe en R2
      try {
        await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
        publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
        console.log(`✅ Ya existe en R2: ${r2Key}`);
        return { r2Key, url: publicUrl, source: 'r2_cached' };
      } catch (_) {}

      console.log(`⬇️ Descargando YouTube ${ytId}...`);
      const ua  = randomUA();
      const cmd = `./yt-dlp --no-playlist \
        -f "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio" \
        --extract-audio --audio-format mp3 --audio-quality 5 \
        --user-agent "${ua}" \
        --no-warnings \
        -o "${tmpFile.replace('.mp3', '.%(ext)s')}" \
        "https://www.youtube.com/watch?v=${ytId}"`;
      await execPromise(cmd, TIMEOUT_DL);

      // yt-dlp puede guardar como .m4a → buscar archivo real
      const possibleFiles = [tmpFile, tmpFile.replace('.mp3', '.m4a'), tmpFile.replace('.mp3', '.webm')];
      const existingFile  = possibleFiles.find(f => fs.existsSync(f));
      if (!existingFile) throw new Error('Archivo descargado no encontrado');
      if (existingFile !== tmpFile) fs.renameSync(existingFile, tmpFile);
    }

    // Subir a R2
    if (!r2Key) throw new Error('r2Key no definido');
    console.log(`☁️ Subiendo a R2: ${r2Key}`);
    const fileBuffer = fs.readFileSync(tmpFile);
    await s3.send(new PutObjectCommand({
      Bucket:      R2_BUCKET,
      Key:         r2Key,
      Body:        fileBuffer,
      ContentType: 'audio/mpeg',
    }));

    publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
    console.log(`✅ Subido: ${publicUrl}`);
    return { r2Key, url: publicUrl, source };

  } finally {
    // Limpiar archivo temporal
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ================= PROCESAR JOB =================
async function processJob(jobId, query, youtubeId = null) {
  jobs.set(jobId, { status: 'processing', query });
  activeJobs++;

  try {
    // Si no tenemos youtube_id, buscarlo
    const target = youtubeId || await findYoutubeId(query);

    // Descargar y subir a R2
    const result = await downloadAndUpload(target, jobId);

    jobs.set(jobId, {
      status:    'ready',
      query,
      r2_key:    result.r2Key,
      url:       result.url,
      source:    result.source,
      youtube_id: typeof target === 'string' ? target : null,
      done_at:   Date.now(),
    });
    console.log(`✅ Job ${jobId} completado: ${result.url}`);

  } catch (e) {
    console.error(`❌ Job ${jobId} falló: ${e.message}`);
    jobs.set(jobId, { status: 'failed', query, error: e.message, done_at: Date.now() });
  } finally {
    activeJobs--;
    // Limpiar jobs viejos (>2h)
    const cutoff = Date.now() - 2 * 3600 * 1000;
    for (const [id, job] of jobs) {
      if (job.done_at && job.done_at < cutoff) jobs.delete(id);
    }
  }
}

// ================= ENDPOINTS =================

// POST /process — lanzar job async (Pi no espera)
app.post('/process', async (req, res) => {
  const { query, youtube_id, job_id } = req.body;
  if (!query) return res.status(400).json({ error: 'Falta query' });

  if (activeJobs >= MAX_CONCURRENT)
    return res.status(429).json({ error: 'Servidor ocupado', retry_after: 30 });

  const jobId = job_id || `job_${Date.now()}_${md5(query).slice(0, 8)}`;

  // Responder inmediatamente — job corre en background
  res.json({ job_id: jobId, status: 'processing' });

  // Lanzar procesamiento async
  processJob(jobId, query, youtube_id).catch(e => console.error(e));
});

// GET /status/:jobId — Pi hace polling cada 30s
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json(job);
});

// GET /audio — búsqueda rápida URL directa (para Alexa con cache R2)
// Si Pi tiene r2_key en SQLite, no llama a este endpoint
// Solo se usa como fallback
app.get('/audio', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Falta q' });

  if (activeJobs >= MAX_CONCURRENT)
    return res.status(429).json({ error: 'Servidor ocupado' });

  const jobId = `quick_${md5(query).slice(0, 8)}`;
  activeJobs++;
  try {
    const target = await findYoutubeId(safeQuery(query));
    if (typeof target === 'object' && target.type === 'direct_url') {
      return res.json({ url: target.url, source: target.source, cached: false });
    }
    // Devolver URL de R2 si ya existe
    const r2Key = `songs/${md5(target)}.mp3`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
      return res.json({ url: `${R2_PUBLIC_URL}/${r2Key}`, source: 'r2', cached: true });
    } catch (_) {}
    // No está en R2 — devolver error para que Pi lance job
    res.status(202).json({ status: 'not_cached', youtube_id: target, message: 'Use /process' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    activeJobs--;
  }
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    activeJobs,
    pendingJobs: [...jobs.values()].filter(j => j.status === 'processing').length,
    uptime:     Math.floor(process.uptime()),
  });
});

// GET /debug
app.get('/debug', async (req, res) => {
  try {
    const version = await execPromise('./yt-dlp --version', 5000);
    res.json({ yt_dlp: version, node: process.version, r2_configured: !!R2_ACCESS_KEY });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`🚀 kimi-audio R2 en puerto ${port}`));
