# AI Video Factory — GPU Render Node

Render AI Video Factory jobs with your **NVIDIA GPU** — no SwiftShader, no CPU encoding.

This standalone app runs on any machine with an NVIDIA GPU (Windows, Linux, macOS). It connects to the shared workspace over your Tailscale VPN, renders with real GPU acceleration via Remotion, streams live progress to a visual dashboard, and uploads finished videos to Google Drive automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your PC (Windows / Linux / macOS)                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  localhost:3000  — Visual Dashboard                 │   │
│  │                                                     │   │
│  │  • GPU: name, util %, VRAM, temp                    │   │
│  │  • Queue: pending / rendering / done / failed       │   │
│  │  • Per-job: stage, progress %, frames, elapsed time  │   │
│  │  • Live log viewer (Remotion stderr stream)         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Remotion + NVIDIA GPU ──► MP4                             │
│  Drive upload (auto on complete)                           │
└─────────────────────────────────────────────────────────────┘
        ▲                                      │
        │  Tailscale VPN                       │
        │  (shared queue dir)                  │
        ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  OpenClaw Container (Linux)                                 │
│                                                             │
│  video_factory.py ──► queue/pending/ ──► queue/done/       │
│  Google Drive upload                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 20+ | `node --version` |
| Python | 3.10+ | `python --version` |
| NVIDIA GPU | Kepler+ | `nvidia-smi` |
| NVIDIA Driver | Latest | `nvidia-smi` shows driver version |
| Git | Any | `git --version` |
| FFmpeg | Any | `ffmpeg -version` |
| Tailscale | Any | `tailscale status` |

---

## Step 1 — Set up Tailscale (zero-config VPN)

This connects your PC and the container without opening any firewall ports.

### On the OpenClaw container host

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate (one-time)
tailscale up --accept-routes --accept-dns

# Serve the workspace on the tailnet
tailscale serve --bg /data
```

This makes the workspace available at `http://<container-tailnet-ip>:18789` to all tailnet devices.

### On your Windows PC

```powershell
# Install Tailscale
winget install tailscale.tailscale

# Authenticate
tailscale up --accept-routes --accept-dns

# Verify you can reach the container
ping <container-tailnet-ip>
```

---

## Step 2 — Clone the repo

```bash
git clone https://github.com/stephenbuilderai/ai-video-factory-gpu-node.git
cd ai-video-factory-gpu-node
```

---

## Step 3 — Set up the Remotion render-worker

The GPU node renders using the Remotion project from the main AI Video Factory repo. You have two options:

### Option A — Clone the main repo (recommended for keeping up to date)

```bash
# Outside the gpu-render-node directory
git clone https://github.com/stephenbuilderai/ai-video-factory.git ../ai-video-factory
```

Then in your `.env`:
```env
REMOTION_PROJECT_ROOT=C:/Projects/ai-video-factory/systems/ai-video-factory/render-worker
WORKSPACE_ROOT=C:/Projects/ai-video-factory
```

### Option B — Use a Tailscale file share

On the container:
```bash
tailscale serve --bg /data
```

On your PC, access the container's `systems/ai-video-factory/render-worker/` via `\\<container-tailnet-ip>\data\` using Tailscale SFTP or a network share.

---

## Step 4 — Install dependencies

```bash
cd ai-video-factory-gpu-node

# Install the GPU node app
npm install

# Install render-worker dependencies (in the Remotion project)
cd systems/ai-video-factory/render-worker
npm install
```

> **Note:** If you used Option A and cloned into `../ai-video-factory`, the `render-worker` is at `../ai-video-factory/systems/ai-video-factory/render-worker`.

---

## Step 5 — Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# ─── Paths ────────────────────────────────────────────────────────────────

# Root of the shared workspace (must be same path on both machines,
# OR accessible via Tailscale mount/smb)
WORKSPACE_ROOT=C:/Projects/ai-video-factory

# Path to the Remotion render-worker project
REMOTION_PROJECT_ROOT=C:/Projects/ai-video-factory/systems/ai-video-factory/render-worker

# ─── Google Drive ────────────────────────────────────────────────────────

# Folder ID to upload completed renders
# Get from the folder URL: drive.google.com/drive/folders/<THIS_PART>
GDRIVE_FOLDER_ID=0ABS7lV30kSIDUk9PVA

# OAuth token for Google Drive API
# On the container: openclaw config get drive.token
GDRIVE_TOKEN=ya29.a0AfH6SMB...

# ─── Tailscale / Network ──────────────────────────────────────────────────

# Tailscale IP of the OpenClaw container host
# Run `tailscale status` on the container to find this
TAILNET_HOST=100.123.45.67

# ─── Dashboard ────────────────────────────────────────────────────────────

PORT=3000
```

---

## Step 6 — Get a fresh Google Drive token

On the container:

```bash
openclaw config get drive.token
```

Copy the value into `GDRIVE_TOKEN` in your `.env`.

If the container doesn't have a Drive token configured, see the main AI Video Factory docs for setting up the Google Workspace integration.

---

## Step 7 — Run the GPU render node

```bash
cd ai-video-factory-gpu-node
node app.mjs
```

You should see:

```
[2026-04-05T18:00:00.000Z] GPU Render Node running at http://localhost:3000
[2026-04-05T18:00:00.000Z] Workspace: C:/Projects/ai-video-factory
[2026-04-05T18:00:00.000Z] Queue watch: C:/Projects/ai-video-factory/systems/ai-video-factory/runtime/render-sidecar/queue/pending
```

Open **http://localhost:3000** in your browser.

---

## Step 8 — Submit a job from the container

On the container:

```bash
cd /data/.openclaw/workspace
python3 systems/ai-video-factory/scripts/video_factory.py run-pipeline \
  --topic "What is GPT-5?" \
  --platform reels \
  --format ai_breakdown \
  --audience beginner
```

The GPU node will pick it up automatically within 3 seconds.

---

## Dashboard Reference

| Area | Shows |
|---|---|
| **GPU — Name** | NVIDIA GPU model |
| **GPU — 利用率** | GPU utilization % |
| **GPU — 显存** | VRAM used / total |
| **GPU — 温度** | GPU temperature °C |
| **队列** | All jobs, color-coded by status |
| **当前任务详情** | Job ID, stage, progress %, rendered frames, elapsed |
| **渲染日志** | Live Remotion stderr |

**Job status badges:**
- 🟢 **渲染中** (pulsing) — actively rendering
- ✅ **完成** — succeeded
- 🔴 **失败** — failed (check log viewer for error)

---

## Render Quality

The GPU render script uses:

```
--use-gl=angle --enable-features=VaapiVideoDecoder --use-native-gl-for=angle
--enable-gpu-rasterization --zero-copy-video
```

This gives you real hardware-accelerated encoding via NVIDIA's NVENC + VAAPI, not software encoding.

**Quality settings (from `remotion.config.mjs`):**
- Scale: 2x (renders 2160×3840, outputs 1080×1920)
- Codec: H.264
- Color space: BT.709
- CRF: 18 (near-lossless)

---

## Troubleshooting

### "GPU: 未检测" — GPU not showing up

```powershell
nvidia-smi
```

If this fails, reinstall NVIDIA drivers. Remotion uses Chromium with ANGLE — it must be able to see the GPU.

### Jobs queue but never start

1. Check `WORKSPACE_ROOT` is the **same absolute path** on both machines, or the mount is accessible
2. Check the container is reachable: `ping <TAILNET_HOST>`
3. Check the queue directory exists:
   ```powershell
   dir C:\Projects\ai-video-factory\systems\ai-video-factory\runtime\render-sidecar\queue\pending
   ```

### Render output is black or has visual glitches

Try disabling the GPU sandbox (some laptop configurations need this):

```env
DISABLE_GPU_SANDBOX=true
```

### Drive upload fails

1. Verify token is fresh: `openclaw config get drive.token` (tokens expire)
2. Check `GDRIVE_FOLDER_ID` is correct
3. Check the Drive API is enabled in your Google Cloud project

### Dashboard shows "Connecting…" forever

The SSE connection (`/events`) is going to `localhost:3000`. Make sure `app.mjs` is still running and not crashing silently. Check stdout/stderr.

---

## File Structure

```
ai-video-factory-gpu-node/
├── app.mjs                          # Main app: dashboard + queue runner
├── package.json                     # Dependencies
├── .env.example                     # Config template
├── README.md                        # This file
└── systems/                         # (optional) symlink or copy
    └── ai-video-factory/
        └── systems/
            └── ai-video-factory/
                └── render-worker/    # Remotion project
                    ├── src/          # Remotion components
                    ├── remotion.config.mjs
                    ├── scripts/
                    │   └── render-job-gpu.mjs  # GPU-accelerated render
                    └── package.json
```

---

## Updating

```bash
cd ai-video-factory-gpu-node
git pull origin main

# Also update the Remotion render-worker if using Option A
cd ../ai-video-factory
git pull origin main
```
