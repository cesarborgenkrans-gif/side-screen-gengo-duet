/* ============================================================
   DUET — main process
   Frameless window sized to the exact bounds of the target panel.
   IPC: read-source (a "Copy as path" file → text or base64 image, or raw text),
   llm-chat (messages[]-based, proxied to LM Studio to dodge CORS + support vision),
   llm-models (connection test). One LM Studio model drives both personas.
   ============================================================ */
const { app, BrowserWindow, screen, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const {
  LOAD_CONTEXT_LENGTH,
  assessModelFit,
  fetchLmStudioCatalog,
  findCatalogModel,
  isLoaded,
  probeHardware,
  publicModel
} = require('./hardware-safety');

const TARGET_X = parseInt(process.env.FOUNDRY_TARGET_X || '3440', 10);
const MAIN_ZOOM = Math.min(1, Math.max(0.2, parseFloat(process.env.FOUNDRY_MAIN_ZOOM || '0.5')));
const WINDOWED = process.argv.includes('--windowed');
const MAX_TEXT = 60000;   // cap pasted/loaded document size sent to the model
const APP_USER_MODEL_ID = 'dev.sparklesnap.gengo-duet';
const APP_ICON = path.join(__dirname, 'assets', 'icon.ico');

if (process.env.GENGO_QA_USER_DATA) app.setPath('userData', path.resolve(process.env.GENGO_QA_USER_DATA));

let mainWindow = null;
let panelBounds = null;
let currentLocation = 'panel';
let boundsReassertTimer = null;

function logDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  const info = screen.getAllDisplays().map((d, i) => ({
    index: i, id: d.id, primary: d.id === primaryId,
    bounds: d.bounds, size: d.size, rotation: d.rotation, scaleFactor: d.scaleFactor
  }));
  try { fsSync.writeFileSync(path.join(__dirname, 'displays-detected.json'), JSON.stringify(info, null, 2)); } catch {}
}

function pickTargetDisplay() {
  const displays = screen.getAllDisplays();
  const idx = parseInt(process.env.FOUNDRY_TARGET_DISPLAY ?? '', 10);
  if (!Number.isNaN(idx) && displays[idx]) return displays[idx];
  const sig = displays.find(d => {
    const { width: w, height: h } = d.bounds;
    return (w === 1440 && h === 2560) || (w === 2560 && h === 1440);
  });
  if (sig) return sig;
  const byX = displays.find(d => d.bounds.x >= TARGET_X);
  if (byX) return byX;
  const primaryId = screen.getPrimaryDisplay().id;
  return displays.find(d => d.id !== primaryId) || displays[displays.length - 1];
}

function createWindow() {
  const base = {
    frame: false, resizable: false, movable: false, alwaysOnTop: false,
    icon: APP_ICON,
    backgroundColor: '#f5f1e8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true }
  };
  if (WINDOWED) {
    mainWindow = new BrowserWindow({ ...base, width: 480, height: 854, frame: true, resizable: true, movable: true, alwaysOnTop: false });
  } else {
    const t = pickTargetDisplay();
    const b = t.bounds;
    mainWindow = new BrowserWindow({ ...base, x: b.x, y: b.y, width: b.width, height: b.height });
    const enforce = () => { try { mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }); } catch {} };
    mainWindow.once('ready-to-show', enforce);
    mainWindow.webContents.once('did-finish-load', enforce);
    // The display owns home geometry. Reading a fresh cross-monitor window here
    // can capture Windows' temporary clamp and poison every later return.
    panelBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  mainWindow.loadFile('index.html');
  if (!panelBounds) {
    const [x, y] = mainWindow.getPosition();
    const [width, height] = mainWindow.getSize();
    panelBounds = { x, y, width, height };
  }
  currentLocation = 'panel';
  mainWindow.on('closed', () => (mainWindow = null));
}

function computeMainStripBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const aspect = panelBounds?.height ? panelBounds.width / panelBounds.height : 0.5625;
  let height = workArea.height;
  let width = Math.round(height * aspect);
  const maxWidth = Math.round(workArea.width * 0.6);
  if (width > maxWidth) { width = maxWidth; height = Math.round(width / aspect); }
  return {
    x: workArea.x + workArea.width - width,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  };
}

async function moveWindowTo(target) {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const destination = (target === 'panel' || target === 'main')
    ? target : (currentLocation === 'panel' ? 'main' : 'panel');
  let bounds;
  if (destination === 'main') bounds = computeMainStripBounds();
  else if (!WINDOWED) {
    const display = pickTargetDisplay();
    bounds = display ? { ...display.bounds } : panelBounds;
  } else bounds = panelBounds;
  if (!bounds) return { ok: false, error: 'no target bounds' };

  const zoom = destination === 'main' ? MAIN_ZOOM : 1;
  try {
    if (!mainWindow.isResizable()) mainWindow.setResizable(true);
    if (boundsReassertTimer) clearTimeout(boundsReassertTimer);
    mainWindow.setBounds(bounds);
    try { mainWindow.webContents.setZoomFactor(zoom); } catch {}
    boundsReassertTimer = setTimeout(() => {
      try { mainWindow.setBounds(bounds); } catch {}
      try { mainWindow.webContents.setZoomFactor(zoom); } catch {}
      if (!WINDOWED) { try { mainWindow.setResizable(false); } catch {} }
      boundsReassertTimer = null;
    }, 60);
    currentLocation = destination;
    return { ok: true, location: destination, zoom };
  } catch (error) { return { ok: false, error: error.message }; }
}

ipcMain.handle('move-window', async (_e, target) => moveWindowTo(target));
ipcMain.handle('window-location', async () => ({ ok: true, location: currentLocation }));
ipcMain.handle('window-minimize', async () => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  mainWindow.minimize();
  return { ok: true };
});
ipcMain.handle('window-close', async () => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  mainWindow.close();
  return { ok: true };
});
ipcMain.handle('window-set-always-on-top', async (_e, enabled) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  mainWindow.setAlwaysOnTop(!!enabled);
  return { ok: true, alwaysOnTop: mainWindow.isAlwaysOnTop() };
});
ipcMain.handle('window-always-on-top', async () => ({
  ok: !!mainWindow,
  alwaysOnTop: !!mainWindow?.isAlwaysOnTop()
}));

// ── read a source: file path (text/image) or raw pasted text ──
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
ipcMain.handle('read-source', async (_e, raw) => {
  let s = String(raw ?? '').trim();
  // strip surrounding quotes that Windows "Copy as path" adds
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1);
  if (!s) return { ok: false, error: 'Nothing to read — paste a file path or some text.' };
  let stat = null; try { stat = await fs.stat(s); } catch {}
  if (stat && stat.isFile()) {
    const ext = path.extname(s).toLowerCase();
    if (IMG_MIME[ext]) {
      const buf = await fs.readFile(s);
      return { ok: true, kind: 'image', name: path.basename(s), mime: IMG_MIME[ext],
               dataUrl: `data:${IMG_MIME[ext]};base64,${buf.toString('base64')}`, bytes: buf.length };
    }
    try {
      let text = await fs.readFile(s, 'utf8');
      const truncated = text.length > MAX_TEXT;
      if (truncated) text = text.slice(0, MAX_TEXT);
      return { ok: true, kind: 'text', name: path.basename(s), text, truncated };
    } catch (e) { return { ok: false, error: `Could not read ${path.basename(s)} as text: ${e.message}` }; }
  }
  // not a file → treat as raw text
  let text = s; const truncated = text.length > MAX_TEXT; if (truncated) text = text.slice(0, MAX_TEXT);
  return { ok: true, kind: 'text', name: '(pasted text)', text, truncated };
});

// ── LLM chat (messages[] passthrough, supports vision content parts) ──
ipcMain.handle('llm-chat', async (_e, opts) => {
  const { baseURL, apiKey, model, temperature, messages, provider } = opts || {};
  try {
    if (provider === 'lmstudio') {
      const wanted = String(model || '').trim();
      if (!wanted) return { ok: false, code: 'model_required', error: 'Choose a downloaded model first.' };
      let catalog;
      try { catalog = await fetchLmStudioCatalog({ baseURL, apiKey }); }
      catch (error) { return { ok: false, code: 'catalog_unavailable', error: error.message }; }
      const target = findCatalogModel(catalog.models, wanted);
      if (!target) return { ok: false, code: 'model_missing', error: `Model "${wanted}" is not downloaded in LM Studio.` };
      if (!isLoaded(target)) {
        return { ok: false, code: 'model_not_loaded', model: target.key, error: `Load "${target.key}" safely from Settings before starting a lesson.` };
      }
    }
    const url = `${(baseURL || 'http://localhost:1234/v1').replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'lm-studio'}` };
    if (/openrouter\.ai/i.test(url)) { headers['HTTP-Referer'] = 'https://sparklesnap.dev'; headers['X-Title'] = 'SparkleSnap Gengo Duet'; }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model || 'local-model', messages, temperature: typeof temperature === 'number' ? temperature : 0.7,
        frequency_penalty: 0.6, presence_penalty: 0.4, stream: false })
    });
    if (!res.ok) return { ok: false, error: `LM Studio HTTP ${res.status}: ${(await res.text()).slice(0, 240)}` };
    const data = await res.json();
    return { ok: true, text: data?.choices?.[0]?.message?.content ?? '' };
  } catch (e) {
    return { ok: false, error: `${e.message} — is LM Studio's server running (Developer ▸ Start Server)?` };
  }
});

ipcMain.handle('llm-models', async (_e, opts) => {
  const { baseURL, apiKey } = opts || {};
  try {
    const url = `${(baseURL || 'http://localhost:1234/v1').replace(/\/+$/, '')}/models`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey || 'lm-studio'}` } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data?.data || []).map(m => m.id) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('llm-catalog', async (_e, opts) => {
  try {
    const [{ origin, models }, hardware] = await Promise.all([
      fetchLmStudioCatalog(opts || {}),
      probeHardware(opts || {})
    ]);
    return { ok: true, origin, hardware, models: models.map(model => publicModel(model, hardware)) };
  } catch (error) {
    return { ok: false, code: 'catalog_unavailable', error: error.message };
  }
});

// Load only an explicitly selected, downloaded model after a fail-closed memory check.
ipcMain.handle('llm-load', async (_e, opts) => {
  const { baseURL, apiKey, model, voiceURL } = opts || {};
  const wanted = String(model || '').trim();
  const auth = { Authorization: `Bearer ${apiKey || 'lm-studio'}` };
  if (!wanted) return { ok: false, code: 'model_required', error: 'Choose a downloaded model first.' };

  try {
    const [{ origin, models }, hardware] = await Promise.all([
      fetchLmStudioCatalog({ baseURL, apiKey }),
      probeHardware({ voiceURL })
    ]);
    const target = findCatalogModel(models, wanted);
    if (!target) return { ok: false, code: 'model_missing', error: `Model "${wanted}" is not downloaded in LM Studio.` };
    if (isLoaded(target)) return { ok: true, status: 'already', code: 'already_loaded', model: target.key };

    const assessment = assessModelFit(target, hardware);
    if (!assessment.allowed) {
      const error = assessment.code === 'hardware_unknown'
        ? 'Memory could not be measured, so model loading is locked for safety.'
        : `Model needs about ${assessment.requiredGiB} GiB; only ${assessment.availableGiB ?? 0} GiB is safely available.`;
      return { ok: false, status: 'blocked', code: assessment.code, error, model: target.key, assessment, hardware };
    }

    const response = await fetch(`${origin}/api/v1/models/load`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        model: target.key,
        context_length: LOAD_CONTEXT_LENGTH,
        flash_attention: true,
        offload_kv_cache_to_gpu: false,
        echo_load_config: true
      })
    });
    if (!response.ok) return { ok: false, error: `LM Studio HTTP ${response.status}: ${(await response.text()).slice(0, 240)}` };
    return { ok: true, status: 'loaded', code: 'loaded', model: target.key, assessment, hardware, load: await response.json() };
  } catch (error) { return { ok: false, error: error.message }; }
});

// ── Compatible local TTS add-on: synthesize a line → WAV (base64) ──
const trimU = u => (u || 'http://localhost:3113').replace(/\/+$/, '');
ipcMain.handle('tts-generate', async (_e, opts) => {
  const { baseURL, text, voice_design, language, cfg_value, inference_timesteps, seed } = opts || {};
  try {
    const res = await fetch(`${trimU(baseURL)}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, voice_design: voice_design || '', language: language || 'English', mode: 'voice-design',
        cfg_value: cfg_value ?? 2.0, inference_timesteps: inference_timesteps ?? 10,
        seed: seed ?? -1, max_len: 4096, denoise: false, consent_ack: true
      })
    });
    if (!res.ok) return { ok: false, error: `Voice server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, base64: buf.toString('base64'), mime: 'audio/wav', sampleRate: res.headers.get('X-Sample-Rate') || '' };
  } catch (e) { return { ok: false, error: `${e.message} — is a compatible voice server running at ${trimU(baseURL)}?` }; }
});

// ── Local TTS VRAM telemetry / unload (overload protection) ──
ipcMain.handle('vram-telemetry', async (_e, baseURL) => {
  try {
    const res = await fetch(`${trimU(baseURL)}/api/vram`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (e) { return { ok: false, error: e.message }; }
});
// ── open a credit link in the external browser ──
ipcMain.handle('open-url', async (_e, url) => {
  if (!/^https?:\/\//.test(url)) return { ok: false, error: 'invalid URL' };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

app.setAppUserModelId(APP_USER_MODEL_ID);

app.whenReady().then(() => {
  logDisplays();
  createWindow();
  if (process.env.FOUNDRY_AUTOTEST === '1') {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      await wait(1500);
      const output = { panelBounds, atStart: mainWindow.getBounds() };
      output.moveMain = await moveWindowTo('main');
      await wait(900);
      output.onMain = mainWindow.getBounds();
      output.movePanel = await moveWindowTo('panel');
      await wait(900);
      output.backOnPanel = mainWindow.getBounds();
      output.ok = JSON.stringify(output.backOnPanel) === JSON.stringify(output.atStart);
      try { fsSync.writeFileSync(path.join(__dirname, 'autotest-bounds.json'), JSON.stringify(output, null, 2)); } catch {}
      app.quit();
    });
  }
  if (process.env.GENGO_UI_AUTOTEST === '1') {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    mainWindow.webContents.once('did-finish-load', async () => {
      await wait(900);
      await mainWindow.webContents.executeJavaScript("document.getElementById('gear').click()");
      await wait(2200);
      const metrics = await mainWindow.webContents.executeJavaScript(`(async () => {
        const select = document.getElementById('cfg-model-local');
        if ([...select.options].some(option => option.value === 'google/gemma-4-12b')) {
          select.value = 'google/gemma-4-12b';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const rect = id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const guardResult = await window.gengo.llmLoad({
          baseURL: 'http://localhost:1234/v1',
          apiKey: 'lm-studio',
          model: 'google/gemma-4-12b',
          voiceURL: 'http://localhost:3113'
        });
        return {
          theme: document.body.dataset.theme,
          closeText: document.getElementById('btn-close').innerText.trim(),
          closeRect: rect('btn-close'),
          settingsHidden: document.getElementById('settings').hidden,
          settingsRect: rect('settings'),
          heading: document.getElementById('settings-heading').innerText.trim(),
          hardwareText: document.getElementById('hardware-summary').innerText.trim(),
          hardwareClass: document.getElementById('hardware-safety').className,
          modelValue: select.value,
          modelOptions: [...select.options].map(option => option.innerText),
          labelFontPx: getComputedStyle(document.querySelector('.settings-grid > label')).fontSize,
          inputFontPx: getComputedStyle(document.getElementById('cfg-model-local')).fontSize,
          inputHeightPx: rect('cfg-model-local').height,
          actionHeightPx: rect('btn-loadmodel').height,
          guardResult
        };
      })()`);
      const qaDir = path.join(__dirname, 'qa');
      fsSync.mkdirSync(qaDir, { recursive: true });
      fsSync.writeFileSync(path.join(qaDir, 'settings-live.json'), JSON.stringify(metrics, null, 2));
      const image = await mainWindow.webContents.capturePage();
      fsSync.writeFileSync(path.join(qaDir, 'settings-live.png'), image.toPNG());
      app.quit();
    });
  }
  globalShortcut.register('Escape', () => app.quit());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
