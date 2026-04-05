/**
 * render-job-gpu.mjs
 *
 * GPU-accelerated Remotion render.
 * Uses native Chromium GPU (ANGLE/VAAPI) instead of SwiftShader.
 *
 * Usage:
 *   node scripts/render-job-gpu.mjs '{"job_id":"...","render_package_path":"...","output_path":"...","codec":"h264"}'
 */

import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia} from '@remotion/renderer';

const [,, rawJob] = process.argv;
if (!rawJob) {
  console.error('Usage: node scripts/render-job-gpu.mjs <job-json>');
  process.exit(1);
}

const job = JSON.parse(rawJob);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const factoryRoot = path.resolve(projectRoot, '..');
const workspaceRoot = path.resolve(factoryRoot, '..', '..');
const googleWorkspaceCli = path.join(workspaceRoot, 'scripts', 'google-workspace');
const defaultUploadFolderId = process.env.AI_VIDEO_FACTORY_GDRIVE_FOLDER_ID || process.env.GOOGLE_WORKSPACE_FOLDER_ID || '';
const defaultUploadNameSuffix = process.env.AI_VIDEO_FACTORY_GDRIVE_NAME_SUFFIX || '';

const persistJson = (targetPath, value) => {
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2) + '\n');
};

const sidecarMetaPath = (outputPath, kind) => {
  const p = path.parse(outputPath);
  return path.join(p.dir, `${p.name}.${kind}.json`);
};

const parseJsonOutput = (stdout, fallback = {}) => {
  try { return JSON.parse(stdout); } catch { return fallback; }
};

const buildNotificationPayload = (job, upload) => ({
  type: 'ai-video-factory.render_ready',
  job_id: job.job_id,
  request_id: job.request_id,
  status: 'succeeded',
  output_path: job.output_path,
  render_package_path: job.render_package_path,
  drive_file_id: upload?.file?.id || null,
  drive_url: upload?.file?.webViewLink || null,
});

const uploadRenderedOutput = (job) => {
  if (!defaultUploadFolderId) return {ok: false, skipped: true, reason: 'missing_folder_id'};
  if (!fs.existsSync(googleWorkspaceCli)) return {ok: false, skipped: true, reason: 'missing_google_workspace_cli'};
  const parsedOutput = path.parse(job.output_path);
  const uploadName = `${parsedOutput.name}${defaultUploadNameSuffix}${parsedOutput.ext}`;
  const proc = spawnSync(googleWorkspaceCli, [
    'upload-file', '--localPath', job.output_path,
    '--folderId', defaultUploadFolderId,
    '--mimeType', 'video/mp4', '--name', uploadName,
  ], {cwd: workspaceRoot, env: process.env, encoding: 'utf8'});
  const stdout = proc.stdout || '', stderr = proc.stderr || '';
  if (proc.status !== 0) {
    return {ok: false, skipped: false, reason: 'upload_failed', error: stderr.trim() || stdout.trim(), status: proc.status};
  }
  const result = parseJsonOutput(stdout, {});
  return {...result, folder_id: defaultUploadFolderId, uploaded_name: uploadName};
};

const DISABLE_GPU_SANDBOX = process.env.DISABLE_GPU_SANDBOX === 'true';

// ─── GPU Chromium options ─────────────────────────────────────────────────────
const GPU_CHROMIUM_OPTIONS = {
  // Use ANGLE with NVIDIA (Windows: d3d11, Linux: glx, macOS: metal)
  gl: process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'glx',
  args: [
    '--enable-features=VaapiVideoDecoder',
    '--use-native-gl-for=angle',
    '--no-gpu-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--zero-copy-video',
  ],
  // Prefer dedicated GPU on laptops (Windows)
  preferGpuDeviceIndex: 0,
};

const entryPoint = path.join(projectRoot, 'src', 'Root.jsx');
const renderPkgAbs = path.isAbsolute(job.render_package_path)
  ? job.render_package_path
  : path.join(workspaceRoot, job.render_package_path);
const outputAbs = path.isAbsolute(job.output_path)
  ? job.output_path
  : path.join(projectRoot, '..', 'runtime', 'render-sidecar', 'outputs', path.basename(job.output_path));

if (!fs.existsSync(entryPoint)) {
  throw new Error(`Remotion entry point not found: ${entryPoint}`);
}
if (!fs.existsSync(renderPkgAbs)) {
  throw new Error(`Render package not found: ${renderPkgAbs}`);
}

console.error(`[gpu-render] bundling ${renderPkgAbs}`);
const serveUrl = await bundle({
  entryPoint,
  webpackOverride: (config) => config,
  enableCaching: true,
});

const inputProps = {renderPackage: JSON.parse(fs.readFileSync(renderPkgAbs, 'utf8'))};

console.error('[gpu-render] loading compositions…');
const compositions = await getCompositions(serveUrl, {
  inputProps,
  chromiumOptions: GPU_CHROMIUM_OPTIONS,
});
const composition = compositions.find(c => c.id === 'RenderPackageVideo');
if (!composition) {
  throw new Error(`Composition RenderPackageVideo not found. Available: ${compositions.map(c => c.id).join(', ')}`);
}

fs.mkdirSync(path.dirname(outputAbs), {recursive: true});
console.error(`[gpu-render] rendering → ${outputAbs}`);
console.error(`[gpu-render] GPU mode: ${GPU_CHROMIUM_OPTIONS.gl}`);

await renderMedia({
  composition,
  serveUrl,
  codec: job.codec || 'h264',
  outputLocation: outputAbs,
  inputProps,
  concurrency: 1,
  chromiumOptions: GPU_CHROMIUM_OPTIONS,
  logLevel: 'verbose',
  onProgress: (progress) => {
    const pct = Math.round((progress.progress || 0) * 100);
    const stage = progress.stitchStage || 'rendering';
    console.error(`[gpu-render] progress=${pct}% rendered=${progress.renderedFrames} encoded=${progress.encodedFrames} stage=${stage}`);
  },
});

console.error('[gpu-render] render complete');
const upload = uploadRenderedOutput({...job, output_path: outputAbs});
const notification = buildNotificationPayload(job, upload);
persistJson(sidecarMetaPath(outputAbs, 'upload'), upload);
persistJson(sidecarMetaPath(outputAbs, 'notify'), notification);
console.log(JSON.stringify({
  status: 'ok',
  output_path: outputAbs,
  gpu_mode: GPU_CHROMIUM_OPTIONS.gl,
  upload,
  notification,
}, null, 2));
