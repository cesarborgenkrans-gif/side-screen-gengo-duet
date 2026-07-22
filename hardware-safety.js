const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const LOAD_CONTEXT_LENGTH = 8192;
const GPU_RESERVE_GIB = 2;
const RAM_RESERVE_GIB = 4;
const RAM_OFFLOAD_WEIGHT = 0.5;

const round1 = value => Math.round(Number(value) * 10) / 10;
const trimBase = value => String(value || 'http://localhost:1234/v1').replace(/\/+$/, '');
const lmStudioOrigin = value => trimBase(value).replace(/\/v1(?:\/.*)?$/i, '');

async function fetchJson(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function probeVoiceGen(baseURL) {
  if (!baseURL) return null;
  try {
    const data = await fetchJson(`${String(baseURL).replace(/\/+$/, '')}/api/vram`, {}, 1200);
    const total = Number(data.total_gib);
    const free = Number(data.free_gib);
    if (!(total > 0) || !(free >= 0)) return null;
    return {
      source: 'voicegen',
      name: String(data.device_name || 'GPU'),
      totalGiB: round1(total),
      freeGiB: round1(Math.min(total, free)),
      usedGiB: round1(Math.max(0, Number(data.used_gib) || total - free))
    };
  } catch {
    return null;
  }
}

async function probeWindowsGpu() {
  if (process.platform !== 'win32') return null;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$items = @()
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Video' -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    $bytes = $p.'HardwareInformation.qwMemorySize'
    $name = $p.'DriverDesc'
    if ($bytes -and $name) { $items += [pscustomobject]@{ name = [string]$name; bytes = [double]$bytes } }
  }
}
$gpu = $items | Sort-Object bytes -Descending | Select-Object -First 1
if (-not $gpu) { throw 'No dedicated GPU memory was reported by Windows.' }
$used = 0
try {
  $used = ((Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples |
    Measure-Object -Property CookedValue -Maximum).Maximum
} catch { $used = 0 }
[pscustomobject]@{
  name = $gpu.name
  totalBytes = [double]$gpu.bytes
  usedBytes = [double]$used
} | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
    ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
    const data = JSON.parse(line);
    const total = Number(data.totalBytes) / GIB;
    const used = Math.max(0, Number(data.usedBytes) / GIB);
    if (!(total > 0)) return null;
    return {
      source: 'windows-driver',
      name: String(data.name || 'GPU'),
      totalGiB: round1(total),
      usedGiB: round1(Math.min(total, used)),
      freeGiB: round1(Math.max(0, total - used))
    };
  } catch {
    return null;
  }
}

async function probeHardware({ voiceURL } = {}) {
  const totalRamGiB = os.totalmem() / GIB;
  const freeRamGiB = os.freemem() / GIB;
  const gpu = await probeVoiceGen(voiceURL) || await probeWindowsGpu();
  return {
    ok: !!gpu && totalRamGiB > 0 && freeRamGiB >= 0,
    gpu,
    ram: {
      totalGiB: round1(totalRamGiB),
      freeGiB: round1(freeRamGiB),
      usedGiB: round1(Math.max(0, totalRamGiB - freeRamGiB))
    }
  };
}

async function fetchLmStudioCatalog({ baseURL, apiKey } = {}) {
  const origin = lmStudioOrigin(baseURL);
  const headers = { Authorization: `Bearer ${apiKey || 'lm-studio'}` };
  const data = await fetchJson(`${origin}/api/v1/models`, { headers });
  const models = (data.models || []).filter(model => model.type === 'llm');
  return { origin, models };
}

function findCatalogModel(models, wanted) {
  const needle = String(wanted || '').trim().toLowerCase();
  if (!needle) return null;
  return models.find(model => String(model.key).toLowerCase() === needle)
    || models.find(model => (model.variants || []).some(variant => String(variant).toLowerCase() === needle))
    || null;
}

function isLoaded(model) {
  return Array.isArray(model?.loaded_instances) && model.loaded_instances.length > 0;
}

function assessModelFit(model, hardware) {
  if (!model) return { allowed: false, code: 'model_missing' };
  const modelGiB = Number(model.size_bytes) / GIB;
  if (!(modelGiB > 0)) return { allowed: false, code: 'model_size_unknown' };
  const requiredGiB = round1(Math.max(modelGiB * 1.35, modelGiB + 2));

  if (isLoaded(model)) {
    return { allowed: true, code: 'already_loaded', modelGiB: round1(modelGiB), requiredGiB };
  }

  const freeVramGiB = Number(hardware?.gpu?.freeGiB);
  const freeRamGiB = Number(hardware?.ram?.freeGiB);
  if (!(freeVramGiB >= 0) || !(freeRamGiB >= 0) || !hardware?.ok) {
    return { allowed: false, code: 'hardware_unknown', modelGiB: round1(modelGiB), requiredGiB };
  }

  const safeVramGiB = Math.max(0, freeVramGiB - GPU_RESERVE_GIB);
  const safeRamGiB = Math.max(0, freeRamGiB - RAM_RESERVE_GIB);
  const availableGiB = round1(safeVramGiB + safeRamGiB * RAM_OFFLOAD_WEIGHT);
  const allowed = requiredGiB <= availableGiB;
  return {
    allowed,
    code: allowed ? 'safe' : 'insufficient_memory',
    modelGiB: round1(modelGiB),
    requiredGiB,
    availableGiB,
    freeVramGiB: round1(freeVramGiB),
    freeRamGiB: round1(freeRamGiB)
  };
}

function publicModel(model, hardware) {
  const assessment = assessModelFit(model, hardware);
  return {
    key: model.key,
    displayName: model.display_name || model.key,
    params: model.params_string || '',
    quantization: model.quantization?.name || '',
    sizeGiB: round1(Number(model.size_bytes) / GIB),
    loaded: isLoaded(model),
    assessment
  };
}

module.exports = {
  GIB,
  LOAD_CONTEXT_LENGTH,
  assessModelFit,
  fetchLmStudioCatalog,
  findCatalogModel,
  isLoaded,
  probeHardware,
  publicModel
};
