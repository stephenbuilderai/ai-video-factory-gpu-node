# AI Video Factory — GPU Render Node

A standalone Node.js app that turns any Windows/macOS/Linux machine with an NVIDIA GPU into a render node for the AI Video Factory. It connects to the shared workspace over Tailscale VPN, renders with real GPU acceleration via Remotion, and serves a local visual dashboard.

---

## What it does

```
┌─────────────────────────────┐         Tailscale VPN
│  GPU Render Node (Windows)  │◄────────────────────┐
│                             │                     │
│  localhost:3000             │                     │
│  ┌──────────────────────┐   │    ┌───────────────▼───────────┐
│  │ Dashboard            │   │    │  OpenClaw Container        │
│  │ • GPU stats          │   │    │                             │
│  │ • Queue monitor      │   │    │  /systems/ai-video-factory │
│  │ • Job progress       │   │    │    /runtime/render-sidecar │
│  │ • Log viewer         │   │    │      /queue/pending/       │
│  └──────────────────────┘   │    │                             │
│                             │    │  video_factory.py queues     │
│  Remotion + NVIDIA GPU ─────│───►│  jobs here                   │
│                             │    │                              │
│  Drive upload on complete ──│───►│  Uploads MP4 to Drive        │
└─────────────────────────────┘    └─────────────────────────────┘
```

---

## Features

- **Real GPU rendering** — Uses NVIDIA GPU via Chromium ANGLE/VAAPI (not SwiftShader)
- **Visual dashboard** — Live GPU util, VRAM, temperature, per-job progress %, log viewer
- **Shared workspace queue** — Monitors the same `queue/pending` dir the container writes to
- **Google Drive upload** — Auto-uploads completed MP4s when credentials are set
- **System tray capable** — Runs headless, dashboard available on-demand
- **Progress streaming** — SSE stream to dashboard, no polling needed

---

## Prerequisites (on Windows)

1. **Node.js 20+** — [nodejs.org](https://nodejs.org)
2. **Python 3** — for the Google Workspace upload CLI
3. **NVIDIA GPU + drivers** — verified with nvidia-smi
4. **Git** — to clone/pull the render-worker source
5. **Tailscale** — [tailscale.com/download/windows](https://tailscale.com/download/windows)
6. **FFmpeg** — `winget install ffmpeg` or [ffmpeg.org](https://ffmpeg.org)

---

## One-time setup

### 1. Share the workspace folder via Tailscale

On the OpenClaw container host, share the workspace:

```powershell
tailscale serve --bg /data /data
# Or use Tailscale SFTP to mount the workspace on Windows
```

Alternatively, on the container run:
```bash
tailscale serve 18790
# This serves the whole container on the tailnet
```

### 2. Install GPU Render Node

```powershell
cd C:\Projects
git clone <repo-url> ai-video-factory
cd ai-video-factory/systems/gpu-render-node
npm install
```

### 3. Copy render-worker source

The GPU node needs the Remotion project. Copy from the container or clone:

```powershell
# Option A: Mount the container workspace via Tailscale SFTP
# The REMOTION_PROJECT_ROOT should point to the shared render-worker

# Option B: Copy the render-worker from the container
scp -r root@<container-tailnet-host>:/data/.openclaw/workspace/systems/ai-video-factory/render-worker C:\Projects\ai-video-factory\systems\
```

### 4. Configure environment

Create `gpu-render-node\.env`:

```env
# Path to the shared workspace (Tailscale-mounted or local copy)
WORKSPACE_ROOT=C:\Projects\workspace

# Path to the render-worker Remotion project
REMOTION_PROJECT_ROOT=C:\Projects\ai-video-factory\systems\ai-video-factory\render-worker

# Google Drive
GDRIVE_FOLDER_ID=0ABS7lV30kSIDUk9PVA
GDRIVE_TOKEN=ya29.a0AfH6SMB...

# Tailscale host of the OpenClaw container (for queue polling)
TAILNET_HOST=100.123.45.67

# Dashboard port (default 3000)
PORT=3000
```

### 5. Authenticate Google Drive

```powershell
# Get a token from the container
openclaw config get drive.token
# Copy it into GDRIVE_TOKEN in your .env
```

### 6. Verify GPU access

```powershell
nvidia-smi
# Should show GPU name, VRAM, temperature
```

### 7. Install GPU render dependencies

Remotion uses Chromium with ANGLE to access the NVIDIA GPU:

```powershell
# Chromium with GPU support should already be installed by @remotion/renderer
# If not:
npm run doctor
```

---

## Running

```powershell
cd C:\Projects\ai-video-factory\systems\gpu-render-node
npm start
```

Dashboard opens at **http://localhost:3000**

Logs:
```powershell
# Live stdout/stderr
npm start 2>&1 | Out-String

# Individual job logs
Get-Content .\runtime\render-sidecar\logs\<job-id>.log
```

---

## Dashboard sections

| Section | What it shows |
|---|---|
| **GPU** | Name, utilization %, VRAM usage, temperature |
| **队列** | All known jobs (pending/rendering/done/failed) |
| **当前任务详情** | Job ID, stage, progress %, rendered frames, elapsed time |
| **渲染日志** | Live stderr stream from Remotion |

---

## Render pipeline

1. Container calls `video_factory.py run-pipeline` → writes job to `queue/pending/`
2. GPU node polls queue every 3 seconds
3. GPU node claims a job (`pending` → `working`)
4. Runs Remotion with real GPU: `node scripts/render-job.mjs <job-json>`
5. On success: uploads MP4 to Drive, writes result JSON
6. Moves job to `queue/done/` or `queue/failed/`
7. SSE pushes update to all dashboard clients

---

## GPU rendering flags

The node uses these Chromium flags for real GPU access:

```
--use-gl=angle
--enable-features=VaapiVideoDecoder
--use-angle=gl=angle
--use-native-gl-for=angle
```

If you encounter issues, check `scripts/doctor.mjs` for diagnostics.

---

## Troubleshooting

**Dashboard shows "未检测" for GPU**
→ Run `nvidia-smi` manually to verify the GPU is visible to the OS

**Queue never picks up jobs**
→ Check `WORKSPACE_ROOT` points to the correct shared path accessible from both container and Windows

**Render starts but output is black / crashed**
→ Try `--disable-gpu-sandbox` flag in `scripts/render-job.mjs` by setting `DISABLE_GPU_SANDBOX=true`

**Drive upload fails**
→ Verify `GDRIVE_TOKEN` is still valid: `openclaw config get drive.token`

---

## Architecture

```
gpu-render-node/
├── app.mjs              # Express server + SSE + job runner
├── package.json
├── .env.example
└── src/                 # (extensible)
    └── renderer.mjs      # GPU render logic (extracted from app.mjs)
```

The node is intentionally stateless — all durable state lives in the shared workspace `runtime/render-sidecar/`.
