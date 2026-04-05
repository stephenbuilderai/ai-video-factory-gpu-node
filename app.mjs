/**
 * AI Video Factory — GPU Render Node
 *
 * Node.js app that:
 *   1. Runs an Express dashboard at localhost:3000
 *   2. Monitors a shared workspace queue directory (via Tailscale VPN path)
 *   3. Renders jobs with real NVIDIA GPU via Remotion
 *   4. Uploads completed renders to Google Drive
 *   5. Streams live progress via Server-Sent Events (SSE)
 *
 * Usage:
 *   WORKSPACE_ROOT=/data/.openclaw/workspace \
 *   REMOTION_PROJECT_ROOT=/path/to/render-worker \
 *   GDRIVE_FOLDER_ID=0ABS7lV... \
 *   GDRIVE_TOKEN=yaoa... \
 *   node app.mjs
 *
 * Dashboard: http://localhost:3000
 */

import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import express from 'express';
import {WebSocketServer} from 'ws';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config from env ──────────────────────────────────────────────────────────

const WORKSPACE_ROOT   = process.env.WORKSPACE_ROOT    || '/data/.openclaw/workspace';
const RENDER_WORKER_ROOT = process.env.REMOTION_PROJECT_ROOT || path.join(WORKSPACE_ROOT, 'systems/ai-video-factory/render-worker');
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID  || process.env.GOOGLE_WORKSPACE_FOLDER_ID || '';
const GDRIVE_TOKEN     = process.env.GDRIVE_TOKEN      || '';
const PORT             = parseInt(process.env.PORT      || '3000', 10);
const TAILNET_HOST     = process.env.TAILNET_HOST      || '127.0.0.1'; // Tailscale IP of container
const QUEUE_WS_URL     = process.env.QUEUE_WS_URL      || `http://${TAILNET_HOST}:18789`;

// ─── Derived paths ────────────────────────────────────────────────────────────

const RUNTIME_ROOT     = path.join(WORKSPACE_ROOT, 'systems/ai-video-factory/runtime/render-sidecar');
const QUEUE_PENDING    = path.join(RUNTIME_ROOT, 'queue/pending');
const QUEUE_WORKING    = path.join(RUNTIME_ROOT, 'queue/working');
const QUEUE_DONE       = path.join(RUNTIME_ROOT, 'queue/done');
const QUEUE_FAILED     = path.join(RUNTIME_ROOT, 'queue/failed');
const OUTPUTS_DIR      = path.join(RUNTIME_ROOT, 'outputs');
const RESULTS_DIR      = path.join(RUNTIME_ROOT, 'results');
const LOGS_DIR         = path.join(RUNTIME_ROOT, 'logs');

// ─── State ───────────────────────────────────────────────────────────────────

const clients = new Map(); // clientId -> { ws, subscriptions }
const jobSessions = new Map(); // jobId -> { status, progress, frames, gpu, startTime, error }
const gpuStats = {利用率: '0%', 显存: '0 MiB', 温度: 'N/A', 名称: '检测中...'};
let gpuMonitorInterval = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

function persistJson(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2) + '\n');
}

function relative(target) {
  try { return path.relative(WORKSPACE_ROOT, target); } catch { return target; }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, c] of clients) {
    try { c.ws.send(msg); } catch {}
  }
}

function buildNotificationPayload(job, upload) {
  return {
    type: 'ai-video-factory.render_ready',
    job_id: job.job_id,
    request_id: job.request_id,
    status: 'succeeded',
    output_path: job.output_path,
    render_package_path: job.render_package_path,
    drive_file_id: upload?.file?.id || null,
    drive_url: upload?.file?.webViewLink || null,
  };
}

// ─── GPU Monitor ──────────────────────────────────────────────────────────────

async function pollGpuStats() {
  return new Promise((resolve) => {
    try {
      const proc = spawn('nvidia-smi', [
        '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name',
        '--format=csv,noheader,nounits',
      ], {timeout: 5000});
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.on('close', (code) => {
        if (code === 0 && out.trim()) {
          const [util, memUsed, memTotal, temp, ...nameParts] = out.trim().split(',').map(s => s.trim());
          const name = nameParts.join(',').trim();
          gpuStats.利用率 = `${util}%`;
          gpuStats.显存 = `${memUsed} / ${memTotal} MiB`;
          gpuStats.温度 = `${temp}°C`;
          gpuStats.名称 = name || 'NVIDIA GPU';
        } else {
          gpuStats.利用率 = 'N/A';
          gpuStats.显存 = 'N/A';
          gpuStats.温度 = 'N/A';
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function startGpuMonitor(intervalMs = 2000) {
  pollGpuStats();
  gpuMonitorInterval = setInterval(pollGpuStats, intervalMs);
}

// ─── Drive Upload ─────────────────────────────────────────────────────────────

function uploadToDrive(localPath) {
  if (!GDRIVE_FOLDER_ID || !GDRIVE_TOKEN) {
    return {ok: false, skipped: true, reason: 'missing_credentials'};
  }
  if (!fs.existsSync(localPath)) {
    return {ok: false, skipped: false, reason: 'file_missing', path: localPath};
  }

  const parsedOutput = path.parse(localPath);
  const uploadName = `${parsedOutput.name}${parsedOutput.ext}`;
  const cliPath = path.join(WORKSPACE_ROOT, 'scripts', 'google-workspace');

  if (!fs.existsSync(cliPath)) {
    return {ok: false, skipped: true, reason: 'missing_cli', cli_path: cliPath};
  }

  const proc = spawnSync(process.execPath, [cliPath, 'upload-file',
    '--localPath', localPath,
    '--folderId', GDRIVE_FOLDER_ID,
    '--mimeType', 'video/mp4',
    '--name', uploadName,
  ], {
    cwd: WORKSPACE_ROOT,
    env: {...process.env, GOOGLE_WORKSPACE_TOKEN: GDRIVE_TOKEN},
    encoding: 'utf8',
  });

  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  if (proc.status !== 0) {
    return {ok: false, skipped: false, reason: 'upload_failed', error: stderr.trim() || stdout.trim(), status: proc.status};
  }
  try {
    const result = JSON.parse(stdout);
    return {ok: true, skipped: false, file: result.file, uploaded_name: uploadName};
  } catch {
    return {ok: false, skipped: false, reason: 'invalid_json_response', stdout: stdout.trim()};
  }
}

// ─── Render with GPU ──────────────────────────────────────────────────────────

async function runRender(jobId, renderPackagePath, outputPath, onProgress) {
  const entryPoint = path.join(RENDER_WORKER_ROOT, 'src', 'Root.jsx');
  // GPU node always uses the GPU-accelerated render script
  const renderScript = path.join(RENDER_WORKER_ROOT, 'scripts', 'render-job-gpu.mjs');

  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Remotion entry point not found: ${entryPoint}`);
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      REMOTION_GPU: 'true',
      // Use native GPU rendering on Windows
      ELECTRON_EXTRA_LAUNCH_ARGS: '--use-gl=angle --enable-features=VaapiVideoDecoder --use-angle=gl=angle --use-native-gl-for=angle',
    };

    const proc = spawn(process.execPath, [renderScript, JSON.stringify({
      job_id: jobId,
      render_package_path: renderPackagePath,
      output_path: outputPath,
      codec: 'h264',
    })], {
      cwd: RENDER_WORKER_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let logBuf = '';
    const logFile = path.join(LOGS_DIR, `${jobId}.log`);
    const logStream = fs.createWriteStream(logFile, {flags: 'a'});
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      logBuf += text;

      // Parse Remotion progress: [render-job] progress=42% rendered=38 encoded=38 stage=encoding
      const progressMatch = text.match(/progress=(\d+)%/);
      const renderedMatch = text.match(/rendered=(\d+)/);
      const encodedMatch  = text.match(/encoded=(\d+)/);
      const stageMatch    = text.match(/stage=(\S+)/);

      if (progressMatch) {
        const progress = parseInt(progressMatch[1], 10);
        const rendered = renderedMatch ? parseInt(renderedMatch[1], 10) : null;
        const encoded  = encodedMatch  ? parseInt(encodedMatch[1], 10)  : null;
        const stage    = stageMatch    ? stageMatch[1]                   : 'rendering';

        jobSessions.set(jobId, {
          ...(jobSessions.get(jobId) || {}),
          status: 'rendering',
          progress,
          rendered,
          encoded,
          stage,
        });
        broadcast('progress', jobSessions.get(jobId));
        if (onProgress) onProgress({progress, rendered, encoded, stage});
      }
    });

    proc.on('close', (code) => {
      logStream.end();
      if (code === 0) {
        resolve({exitCode: 0, logPath: logFile});
      } else {
        reject(new Error(`Render process exited with code ${code}\n${logBuf.slice(-2000)}`));
      }
    });

    proc.on('error', (err) => {
      logStream.end();
      reject(err);
    });
  });
}

// ─── Job Processor ────────────────────────────────────────────────────────────

async function processJob(workingPath) {
  const job = JSON.parse(fs.readFileSync(workingPath, 'utf8'));
  const jobId = job.job_id;
  const startedAt = new Date().toISOString();

  log(`Processing job ${jobId}`);

  jobSessions.set(jobId, {
    jobId,
    requestId: job.request_id,
    status: 'rendering',
    progress: 0,
    rendered: null,
    encoded: null,
    stage: 'starting',
    gpu: {...gpuStats},
    startTime: startedAt,
    outputPath: job.output_path,
    renderPackagePath: job.render_package_path,
  });
  broadcast('job_start', jobSessions.get(jobId));

  try {
    const renderPkgAbs = path.isAbsolute(job.render_package_path)
      ? job.render_package_path
      : path.join(WORKSPACE_ROOT, job.render_package_path);

    const outputAbs = path.isAbsolute(job.output_path)
      ? job.output_path
      : path.join(OUTPUTS_DIR, path.basename(job.output_path));

    fs.mkdirSync(path.dirname(outputAbs), {recursive: true});

    await runRender(jobId, renderPkgAbs, outputAbs, ({progress, rendered, encoded, stage}) => {
      jobSessions.set(jobId, {
        ...(jobSessions.get(jobId) || {}),
        status: 'rendering',
        progress,
        rendered,
        encoded,
        stage,
        gpu: {...gpuStats},
      });
    });

    if (!fs.existsSync(outputAbs)) {
      throw new Error(`Output file not created: ${outputAbs}`);
    }

    const upload = uploadToDrive(outputAbs);
    const notification = buildNotificationPayload(job, upload);

    const result = {
      job_id: jobId,
      request_id: job.request_id,
      status: 'succeeded',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      output_path: outputAbs,
      log_path: path.join(LOGS_DIR, `${jobId}.log`),
      render_package_path: job.render_package_path,
      worker_runtime: 'gpu-render-node',
      gpu: {...gpuStats},
      upload,
      notification,
    };

    persistJson(path.join(RESULTS_DIR, `${jobId}.json`), result);
    jobSessions.set(jobId, {...result, status: 'succeeded', progress: 100});
    broadcast('job_done', jobSessions.get(jobId));

    // Write sidecar metadata beside output
    const sidecarMeta = (kind) => {
      const p = path.parse(outputAbs);
      return path.join(p.dir, `${p.name}.${kind}.json`);
    };
    persistJson(sidecarMeta('upload'), upload);
    persistJson(sidecarMeta('notify'), notification);

    fs.renameSync(workingPath, path.join(QUEUE_DONE, path.basename(workingPath)));
    log(`Job ${jobId} succeeded → ${outputAbs}`);

  } catch (err) {
    const finishedAt = new Date().toISOString();
    const result = {
      job_id: jobId,
      request_id: job.request_id,
      status: 'failed',
      started_at: startedAt,
      finished_at: finishedAt,
      output_path: job.output_path,
      render_package_path: job.render_package_path,
      worker_runtime: 'gpu-render-node',
      error: err.message,
      gpu: {...gpuStats},
    };
    persistJson(path.join(RESULTS_DIR, `${jobId}.json`), result);
    jobSessions.set(jobId, {...result, status: 'failed'});
    broadcast('job_failed', jobSessions.get(jobId));
    fs.renameSync(workingPath, path.join(QUEUE_FAILED, path.basename(workingPath)));
    log(`Job ${jobId} FAILED: ${err.message}`);
  }
}

// ─── Queue Scanner ─────────────────────────────────────────────────────────────

async function scanQueue() {
  try {
    const pending = (fs.readdirSync(QUEUE_PENDING) || [])
      .filter(f => f.endsWith('.json'))
      .sort();

    if (!pending.length) return;

    for (const file of pending) {
      const pendingPath = path.join(QUEUE_PENDING, file);
      const workingPath = path.join(QUEUE_WORKING, file);
      try {
        fs.renameSync(pendingPath, workingPath);
      } catch {
        continue; // already claimed by another worker
      }
      try {
        await processJob(workingPath);
      } catch (err) {
        log(`processJob threw: ${err.message}`);
        try {
          const job = JSON.parse(fs.readFileSync(workingPath, 'utf8'));
          fs.renameSync(workingPath, path.join(QUEUE_FAILED, file));
        } catch {}
      }
    }
  } catch (err) {
    log(`scanQueue error: ${err.message}`);
  }
}

// ─── Express App ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── SSE streams ───────────────────────────────────────────────────────────────

const sseClients = new Map(); // id -> response

app.get('/events', (req, res) => {
  const id = Math.random().toString(36).slice(2);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { clearInterval(heartbeat); }
  }, 15000);

  sseClients.set(id, res);
  // Send current state immediately
  res.write(`event: init\ndata: ${JSON.stringify({gpu: gpuStats, jobs: [...jobSessions.values()]})}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(id);
  });
});

function sseBroadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, res] of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// Override broadcast to also hit SSE
const _origBroadcast = broadcast;
const broadcastAll = (event, data) => {
  _origBroadcast(event, data);
  sseBroadcast(event, data);
};

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    gpu: gpuStats,
    jobs: [...jobSessions.values()],
    uptime: process.uptime(),
  });
});

app.get('/api/jobs', (req, res) => {
  res.json([...jobSessions.values()]);
});

app.get('/api/jobs/:jobId', (req, res) => {
  const s = jobSessions.get(req.params.jobId);
  if (!s) return res.status(404).json({error: 'not_found'});
  res.json(s);
});

app.post('/api/jobs/:jobId/cancel', (req, res) => {
  // Placeholder: killing a running render would require keeping the proc reference
  res.json({ok: false, reason: 'not_implemented'});
});

app.get('/api/logs/:jobId', (req, res) => {
  const logPath = path.join(LOGS_DIR, `${req.params.jobId}.log`);
  if (!fs.existsSync(logPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/plain');
  fs.createReadStream(logPath).pipe(res);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ok: true, gpu: gpuStats, ts: new Date().toISOString()});
});

// ─── Dashboard (bundled inline) ────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHtml());
});

// ─── Start ─────────────────────────────────────────────────────────────────────

// Ensure runtime dirs
for (const d of [QUEUE_PENDING, QUEUE_WORKING, QUEUE_DONE, QUEUE_FAILED, OUTPUTS_DIR, RESULTS_DIR, LOGS_DIR]) {
  fs.mkdirSync(d, {recursive: true});
}

startGpuMonitor(2000);

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  log(`GPU Render Node running at http://localhost:${PORT}`);
  log(`Workspace: ${WORKSPACE_ROOT}`);
  log(`Queue watch: ${QUEUE_PENDING}`);
});

// ─── Queue loop ───────────────────────────────────────────────────────────────

// Poll every 3 seconds
setInterval(scanQueue, 3000);

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GPU Render Node — AI Video Factory</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; }
  header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 600; color: #f0f6fc; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #238636; color: #fff; }
  .badge.warning { background: #9e6a03; }
  .badge.danger { background: #da3633; }
  .grid { display: grid; grid-template-columns: 280px 1fr; gap: 16px; padding: 16px 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .gpu-name { font-size: 20px; font-weight: 700; color: #f0f6fc; margin-bottom: 16px; }
  .gpu-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: #0d1117; border-radius: 6px; padding: 10px 12px; }
  .stat-label { font-size: 11px; color: #8b949e; text-transform: uppercase; }
  .stat-value { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .stat-value.good { color: #3fb950; }
  .stat-value.warn { color: #d29922; }
  .stat-value.bad  { color: #f85149; }
  .progress-bar { background: #21262d; border-radius: 4px; height: 8px; margin-top: 8px; overflow: hidden; }
  .progress-fill { height: 100%; background: #238636; border-radius: 4px; transition: width 0.5s ease; }
  .progress-fill.rendering { background: linear-gradient(90deg, #238636, #3fb950); }
  .job-list { display: flex; flex-direction: column; gap: 8px; }
  .job-item { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; cursor: pointer; transition: border-color 0.15s; }
  .job-item:hover { border-color: #8b949e; }
  .job-item.active { border-color: #238636; }
  .job-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .job-id { font-size: 13px; font-weight: 600; font-family: 'Consolas', monospace; color: #f0f6fc; }
  .job-stage { font-size: 11px; color: #8b949e; }
  .job-progress { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .empty-state { color: #8b949e; font-size: 13px; text-align: center; padding: 24px; }
  .log-viewer { font-family: 'Consolas', 'Courier New', monospace; font-size: 12px; background: #0d1117; border-radius: 6px; padding: 12px; max-height: 300px; overflow-y: auto; color: #8b949e; white-space: pre-wrap; line-height: 1.6; }
  .uptime { font-size: 12px; color: #8b949e; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
  .pulsing { animation: pulse 1.5s ease infinite; }
  .connection-status { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
  .dot.disconnected { background: #da3633; }
  .error-msg { color: #f85149; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>GPU Render Node</h1>
  <span class="badge" id="status-badge">Connecting…</span>
  <div class="connection-status"><span class="dot" id="ws-dot"></span><span id="ws-status">SSE stream</span></div>
  <span class="uptime" id="uptime">—</span>
</header>

<div class="grid">
  <aside>
    <div class="card" style="margin-bottom:16px">
      <h2>GPU</h2>
      <div class="gpu-name" id="gpu-name">—</div>
      <div class="gpu-stats">
        <div class="stat"><div class="stat-label">利用率</div><div class="stat-value" id="gpu-util">—</div></div>
        <div class="stat"><div class="stat-label">显存</div><div class="stat-value" id="gpu-mem">—</div></div>
        <div class="stat"><div class="stat-label">温度</div><div class="stat-value" id="gpu-temp">—</div></div>
        <div class="stat"><div class="stat-label">状态</div><div class="stat-value" id="gpu-status">—</div></div>
      </div>
    </div>
    <div class="card">
      <h2>队列</h2>
      <div class="job-list" id="job-list">
        <div class="empty-state">暂无任务</div>
      </div>
    </div>
  </aside>

  <main>
    <div class="card" style="margin-bottom:16px">
      <h2>当前任务详情</h2>
      <div id="job-detail-empty" class="empty-state">选择左侧任务查看详情</div>
      <div id="job-detail" style="display:none">
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:16px">
          <div class="stat"><div class="stat-label">Job ID</div><div class="stat-value" id="detail-job-id" style="font-size:14px">—</div></div>
          <div class="stat"><div class="stat-label">阶段</div><div class="stat-value" id="detail-stage">—</div></div>
          <div class="stat"><div class="stat-label">进度</div><div class="stat-value" id="detail-progress">—</div></div>
          <div class="stat"><div class="stat-label">耗时</div><div class="stat-value" id="detail-elapsed">—</div></div>
          <div class="stat"><div class="stat-label">已渲染帧</div><div class="stat-value" id="detail-rendered">—</div></div>
          <div class="stat"><div class="stat-label">已编码帧</div><div class="stat-value" id="detail-encoded">—</div></div>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="detail-bar" style="width:0%"></div></div>
        <div id="detail-error" class="error-msg" style="display:none; margin-top:8px"></div>
      </div>
    </div>
    <div class="card">
      <h2>渲染日志</h2>
      <div class="log-viewer" id="log-viewer">等待任务开始…</div>
    </div>
  </main>
</div>

<script>
const $ = (sel) => document.querySelector(sel);
let state = { gpu: {}, jobs: [] };
let selectedJobId = null;
let es = null;
let startTime = Date.now();

function connect() {
  es = new EventSource('/events');
  es.onopen = () => {
    $('#status-badge').textContent = 'Connected';
    $('#status-badge').className = 'badge';
    $('#ws-dot').className = 'dot';
  };
  es.onerror = () => {
    $('#status-badge').textContent = 'Reconnecting…';
    $('#status-badge').className = 'badge warning';
    $('#ws-dot').className = 'dot disconnected';
    es.close();
    setTimeout(connect, 3000);
  };
  es.addEventListener('init', (e) => {
    state = JSON.parse(e.data);
    render(state);
  });
  es.addEventListener('gpu', (e) => {
    state.gpu = JSON.parse(e.data);
    renderGpu(state.gpu);
  });
  es.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    const idx = state.jobs.findIndex(j => j.jobId === data.jobId);
    if (idx >= 0) state.jobs[idx] = data;
    else state.jobs.unshift(data);
    render(state);
    if (selectedJobId === data.jobId) renderDetail(data);
  });
  es.addEventListener('job_start', (e) => {
    const data = JSON.parse(e.data);
    state.jobs = state.jobs.filter(j => j.jobId !== data.jobId);
    state.jobs.unshift(data);
    render(state);
  });
  es.addEventListener('job_done', (e) => {
    const data = JSON.parse(e.data);
    const idx = state.jobs.findIndex(j => j.jobId === data.jobId);
    if (idx >= 0) state.jobs[idx] = data;
    render(state);
    if (selectedJobId === data.jobId) renderDetail(data);
  });
  es.addEventListener('job_failed', (e) => {
    const data = JSON.parse(e.data);
    const idx = state.jobs.findIndex(j => j.jobId === data.jobId);
    if (idx >= 0) state.jobs[idx] = data;
    render(state);
    if (selectedJobId === data.jobId) renderDetail(data);
  });
}

function renderGpu(gpu) {
  $('#gpu-name').textContent = gpu.名称 || '—';
  const util = gpu.利用率 || 'N/A';
  const mem  = gpu.显存   || 'N/A';
  const temp = gpu.温度   || 'N/A';
  $('#gpu-util').textContent = util;
  $('#gpu-mem').textContent  = mem;
  $('#gpu-temp').textContent = temp;
  $('#gpu-util').className = 'stat-value ' + (util === 'N/A' ? '' : parseInt(util) > 80 ? 'bad' : parseInt(util) > 50 ? 'warn' : 'good');
  $('#gpu-status').textContent = gpu.利用率 === 'N/A' ? '未检测' : '运行中';
}

function renderJobs(jobs) {
  const el = $('#job-list');
  if (!jobs || jobs.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无任务</div>';
    return;
  }
  el.innerHTML = jobs.map(j => {
    const isActive = j.status === 'rendering';
    const isDone   = j.status === 'succeeded';
    const isFailed = j.status === 'failed';
    const badgeClass = isDone ? 'badge' : isFailed ? 'badge danger' : isActive ? 'badge pulsing' : 'badge warning';
    const badgeText  = isDone ? '完成' : isFailed ? '失败' : isActive ? '渲染中' : j.status;
    return \`<div class="job-item \${isActive ? 'active' : ''}" onclick="selectJob('\${j.jobId}')">
      <div class="job-item-header">
        <span class="job-id">\${j.jobId}</span>
        <span class="\${badgeClass}">\${badgeText}</span>
      </div>
      <div class="job-item-header">
        <span class="job-stage">\${j.stage || '—'}</span>
        <span class="job-progress">\${j.progress !== undefined ? j.progress + '%' : ''}</span>
      </div>
      \${j.progress !== undefined ? \`<div class="progress-bar"><div class="progress-fill \${isActive?'rendering':''}" style="width:\${j.progress}%"></div></div>\` : ''}
    </div>\`;
  }).join('');
}

function render(state) {
  renderGpu(state.gpu || {});
  renderJobs(state.jobs || []);
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  $('#uptime').textContent = \`运行时间: \${h > 0 ? h + 'h ' : ''}\${m}m \${s}s\`;
}

function selectJob(jobId) {
  selectedJobId = jobId;
  const job = state.jobs.find(j => j.jobId === jobId);
  if (job) renderDetail(job);
  // Fetch live log
  fetch(\`/api/logs/\${jobId}\`)
    .then(r => r.ok ? r.text() : null)
    .then(txt => { $('#log-viewer').textContent = txt || '暂无日志'; })
    .catch(() => { $('#log-viewer').textContent = '无法加载日志'; });
}

function renderDetail(job) {
  $('#job-detail-empty').style.display = 'none';
  $('#job-detail').style.display = 'block';
  $('#detail-job-id').textContent    = job.jobId || '—';
  $('#detail-stage').textContent     = job.stage || job.status || '—';
  $('#detail-progress').textContent  = job.progress !== undefined ? job.progress + '%' : '—';
  $('#detail-encoded').textContent   = job.encoded !== undefined ? job.encoded : '—';
  $('#detail-rendered').textContent = job.rendered !== undefined ? job.rendered : '—';
  const elapsed = job.startTime
    ? Math.floor((Date.now() - new Date(job.startTime).getTime()) / 1000) + 's'
    : '—';
  $('#detail-elapsed').textContent = elapsed;
  $('#detail-bar').style.width = (job.progress || 0) + '%';
  const errEl = $('#detail-error');
  if (job.error) {
    errEl.textContent = '错误: ' + job.error;
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
}

connect();
setInterval(() => {
  fetch('/api/status').then(r => r.json()).then(s => {
    renderGpu(s.gpu || {});
  }).catch(() => {});
}, 5000);
</script>
</body>
</html>`;
}
