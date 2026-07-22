/* Gengo Duet renderer.
   Inherits Duet's core loop: one model, two personas, shared transcript,
   optional compatible local TTS, typewriter/audio turn gating, and source grounding. */
(() => {
  const bridge = (window.gengo && window.gengo.isElectron) ? window.gengo
    : ((window.duet && window.duet.isElectron) ? window.duet : null);
  const $ = id => document.getElementById(id);
  const setStatus = (m, k = '') => { $('status').textContent = m; $('status').className = 'status ' + k; };
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const LANGS = window.I18N_LANGS || [{ code: 'en', native: 'English', llm: 'English', voxcpm: 'English' }];
  const DICT = window.I18N || { en: {} };
  let lang = localStorage.getItem('gengo-lang') || 'en';
  if (!DICT[lang]) lang = 'en';
  const langMeta = () => LANGS.find(l => l.code === lang) || LANGS[0];
  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) || (DICT.en && DICT.en[key]) || key;
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  const tag = key => `[ ${t(key)} ]`;
  const modeName = k => t('m_' + k);
  function applyStaticI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  }

  const THEMES = ['sakura', 'matcha', 'indigo', 'sunrise', 'ink'];
  let theme = localStorage.getItem('gengo-theme') || 'sakura';
  if (!THEMES.includes(theme)) theme = 'sakura';
  function applyTheme() {
    document.body.dataset.theme = theme;
    document.querySelectorAll('.theme-swatch').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

  const DEFAULTS = {
    url: 'http://localhost:1234/v1',
    model: '',
    temp: 0.55,
    key: 'lm-studio',
    voiceURL: 'http://localhost:3113',
    voiceOn: true,
    provider: 'lmstudio',
    alwaysOnTop: false
  };
  const PROVIDERS = {
    lmstudio: { label: 'LM Studio', url: 'http://localhost:1234/v1' },
    ollama: { label: 'Ollama', url: 'http://localhost:11434/v1', modelHint: 'e.g. llama3.2' },
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keyHint: 'OpenRouter API key', modelHint: 'e.g. openai/gpt-4.1-mini' },
    custom: { label: 'Custom' }
  };
  const loadSettings = () => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('gengo-settings') || '{}') }; }
    catch { return { ...DEFAULTS }; }
  };
  let settings = loadSettings();
  const trimURL = u => (u || DEFAULTS.url).replace(/\/+$/, '');
  const DEFAULT_MODEL = 'google/gemma-4-12b';
  const modelId = () => (settings.model || '').trim() || DEFAULT_MODEL;

  const VOICE_DESIGN = {
    tsuki: 'A bright, precise Japanese teacher; youthful, energetic, clear diction, warm classroom confidence, light anime mentor sparkle.',
    selene: 'A calm, reflective Japanese teacher; gentle, lower-pitched, patient, elegant, slow enough for learners, quietly encouraging.'
  };
  const VOICE_SEED = { tsuki: 28, selene: 88 };

  const PERSONAS = {
    tsuki: {
      name: 'Tsuki',
      badge: 'TSUKI-SENSEI',
      sys: `You are TSUKI-SENSEI, the bright Japanese sound-and-use coach of SparkleSnap. You teach pronunciation, rhythm, useful phrases, quick examples, and learner confidence.
VOICE: precise, warm, energetic, elegant, never childish. Use tiny Japanese interjections naturally, such as はい, さあ, いいですね, and なるほど.
TEACHING EDGE: make the learner want to say the Japanese out loud. Give one practical phrase or sound cue per turn.`
    },
    selene: {
      name: 'Selene',
      badge: 'SELENE-SENSEI',
      sys: `You are SELENE-SENSEI, the calm Japanese pattern-and-memory coach of SparkleSnap. You teach grammar logic, nuance, kanji/radical memory, and common mistakes.
VOICE: serene, compact, poetic but practical. Use tiny Japanese interjections naturally, such as なるほど, 本当に, ふふ, and 完璧.
TEACHING EDGE: reveal the hidden pattern, the reason a form works, or the mistake a beginner would make.`
    }
  };

  const LEVELS = {
    starter: 'absolute beginner: kana-friendly, no assumed grammar, romaji only as a temporary scaffold',
    n5: 'JLPT N5: particles, polite forms, basic verbs, everyday nouns, short controlled sentences',
    travel: 'travel Japanese: stations, cafes, shops, hotels, directions, polite survival phrases',
    daily: 'daily-life Japanese: small talk, feelings, schedules, errands, household and work moments',
    creative: 'creative reading: gentle kanji stories, imagery, names, signs, poems, and expressive nuance'
  };
  let lessonLevel = localStorage.getItem('gengo-level') || 'starter';
  if (!LEVELS[lessonLevel]) lessonLevel = 'starter';

  const PEDAGOGY =
    `PEDAGOGY: Teach Japanese, not about Japanese. Keep each turn small and usable. `
    + `Every turn must include exactly one central Japanese item, then a kana reading or segmentation when useful, then a natural meaning. `
    + `Avoid long word lists. Prefer retrieval, contrast, example, memory hook, and one tiny practice action. `
    + `If the source contains mistakes, correct gently and show the natural version.`;
  const SHARED_RULES =
    `Reply only as your character. Use 2-4 short spoken sentences, hard max 80 words. `
    + `No markdown headings. Do not repeat your partner; build on the exact last point. `
    + `Keep persona flavor light; teaching clarity wins.`;
  const STAY_ON_THREAD =
    `Respond directly to your partner's most recent teaching point before adding the next tiny step.`;

  const MODES = {
    phrase: {
      first: 'tsuki',
      framing: 'You are teaching the learner to use one natural Japanese phrase in context.',
      role: sp => sp === 'tsuki'
        ? `Open or continue with sound, rhythm, politeness, and a speakable model sentence.`
        : `Add nuance, when to use it, what not to say, and one compact variation.`,
      roleLabel: sp => sp === 'tsuki' ? 'SOUND' : 'NUANCE'
    },
    grammar: {
      first: 'selene',
      framing: 'You are teaching one Japanese grammar pattern through contrast and tiny examples.',
      role: sp => sp === 'selene'
        ? `Name the pattern, explain the logic, and show the beginner-safe rule.`
        : `Turn the rule into a spoken example and a quick learner action.`,
      roleLabel: sp => sp === 'selene' ? 'PATTERN' : 'PRACTICE'
    },
    kanji: {
      first: 'selene',
      framing: 'You are teaching kanji through meaning, reading, visual memory, and one useful word.',
      role: sp => sp === 'selene'
        ? `Give the visual/radical story and the meaning anchor.`
        : `Give the reading, one real word or phrase, and how to say it naturally.`,
      roleLabel: sp => sp === 'selene' ? 'STORY' : 'VOICE'
    },
    recall: {
      first: 'tsuki',
      framing: 'You are building a micro recall drill from the focus. Alternate prompt and reveal so the learner can self-test while watching.',
      role: sp => sp === 'tsuki'
        ? `Create a very short recall prompt or pronunciation challenge. Include a pause cue, then a tiny hint.`
        : `Reveal the answer, explain why it works, and give one next repetition.`,
      roleLabel: sp => sp === 'tsuki' ? 'PROMPT' : 'REVEAL'
    }
  };
  let currentMode = localStorage.getItem('gengo-mode') || 'phrase';
  if (!MODES[currentMode]) currentMode = 'phrase';

  let source = null;
  const defaultFocus = () => {
    const map = {
      starter: 'Teach a first useful mini-lesson: greeting someone, saying your name, and noticing the rhythm of はじめまして.',
      n5: 'Teach the difference between は and が with one tiny pair of N5-level sentences.',
      travel: 'Teach how to order coffee politely at a cafe, including one natural fallback phrase.',
      daily: 'Teach how to say "I am a little tired today, but I am okay" naturally and politely.',
      creative: 'Teach the kanji 言 through one word, one image, and one memory hook.'
    };
    return map[lessonLevel] || map.starter;
  };

  async function llmChat(messages) {
    const o = { baseURL: settings.url, apiKey: settings.key, model: modelId(), temperature: Number(settings.temp), messages };
    if (bridge) return bridge.llmChat(o);
    try {
      const res = await fetch(`${trimURL(settings.url)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId(),
          messages,
          temperature: Number(settings.temp),
          frequency_penalty: 0.35,
          presence_penalty: 0.25,
          stream: false
        })
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const d = await res.json();
      return { ok: true, text: d?.choices?.[0]?.message?.content ?? '' };
    } catch (e) {
      return { ok: false, error: `${e.message} (browser CORS? run via Electron)` };
    }
  }

  async function llmModels() {
    if (bridge) return bridge.llmModels({ baseURL: settings.url, apiKey: settings.key });
    try {
      const res = await fetch(`${trimURL(settings.url)}/models`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const d = await res.json();
      return { ok: true, models: (d?.data || []).map(m => m.id) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function checkConnection() {
    const el = $('conn');
    el.className = 'conn checking';
    el.textContent = '● ' + t('conn_checking');
    const r = await llmModels();
    const prov = (PROVIDERS[settings.provider] || {}).label || 'LLM';
    if (r.ok) {
      const m = r.models[0] || 'model loaded';
      el.className = 'conn ok';
      el.textContent = `● ${prov} · ${m}`;
      el.title = (r.models || []).join(', ');
    } else {
      el.className = 'conn off';
      el.textContent = '● ' + t('conn_off');
      el.title = r.error || '';
    }
  }

  let modelWarmPromise = null;
  function warmModelSilently() {
    if (!bridge || settings.provider !== 'lmstudio' || !bridge.llmLoad) return Promise.resolve({ ok: false, skipped: true });
    if (!modelWarmPromise) modelWarmPromise = bridge.llmLoad({ baseURL: settings.url, apiKey: settings.key, model: modelId() }).catch(() => ({ ok: false }));
    return modelWarmPromise;
  }

  function transcriptText(transcript) {
    if (!transcript.length) return '(no one has taught yet - you open)';
    return transcript.map(t => `${PERSONAS[t.speaker].name}: ${t.text}`).join('\n\n');
  }

  function sourceSummary() {
    if (!source) return defaultFocus();
    if (source.kind === 'image') return `${source.name} (image focus)`;
    return source.text;
  }

  function buildMessages(speaker, modeKey, transcript, isFirst) {
    const mode = MODES[modeKey];
    const P = PERSONAS[speaker];
    const level = LEVELS[lessonLevel] || LEVELS.starter;
    const language =
      `LANGUAGE: Explain in ${langMeta().llm}. Japanese examples must remain in Japanese script. `
      + `Use romaji only when it helps a beginner pronounce the item.`;
    const system = [
      P.sys,
      mode.framing,
      mode.role(speaker),
      STAY_ON_THREAD,
      PEDAGOGY,
      SHARED_RULES,
      language
    ].join('\n\n');

    const head = `LESSON PATH: ${lessonLevel} - ${level}\nMODE: ${modeName(modeKey)}\nFOCUS MATERIAL (${source ? source.name : 'daily seed'}):`;
    const tail = `\n\nDISCUSSION SO FAR:\n${transcriptText(transcript)}\n\n`
      + (isFirst ? `You open the lesson. ` : '')
      + `Now teach only as ${P.name}.`;

    let userContent;
    if (source && source.kind === 'image') {
      userContent = [
        { type: 'text', text: head + ' (see attached image)' },
        { type: 'image_url', image_url: { url: source.dataUrl } },
        { type: 'text', text: tail }
      ];
    } else {
      userContent = `${head}\n\n${sourceSummary()}${tail}`;
    }
    return [{ role: 'system', content: system }, { role: 'user', content: userContent }];
  }

  function clearLog() { $('log').innerHTML = ''; }
  async function copyText(text) {
    if (!text) return false;
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const field = document.createElement('textarea');
      field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      const ok = document.execCommand('copy'); field.remove(); return ok;
    }
  }
  function appendMsgShell(speaker, modeKey) {
    const P = PERSONAS[speaker];
    const role = MODES[modeKey].roleLabel(speaker);
    const div = document.createElement('div');
    div.className = 'msg ' + speaker;
    div.innerHTML = `<div class="msg-name">${esc(P.badge)} <span class="msg-role">· ${esc(role)}</span></div>`
      + `<div class="msg-body"></div><button class="msg-copy" type="button" disabled>${esc(t('copy_answer'))}</button>`;
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
    const body = div.querySelector('.msg-body');
    const copy = div.querySelector('.msg-copy');
    copy.addEventListener('click', async () => {
      if (await copyText(body.textContent.trim())) { copy.textContent = t('copied'); setTimeout(() => { copy.textContent = t('copy_answer'); }, 1200); }
    });
    return body;
  }
  function setSpeaking(speaker, on) {
    $(speaker === 'tsuki' ? 'tsuki-stage' : 'selene-stage').classList.toggle('speaking', on);
  }

  let running = false;
  let abort = false;
  let currentAudio = null;

  function typewriter(el, text, paceMs) {
    return new Promise(resolve => {
      el.classList.add('typing');
      let i = 0;
      (function step() {
        if (abort) {
          el.textContent = text;
          el.classList.remove('typing');
          return resolve();
        }
        if (i <= text.length) {
          el.textContent = text.slice(0, i);
          i++;
          $('log').scrollTop = $('log').scrollHeight;
          setTimeout(step, paceMs);
        } else {
          el.classList.remove('typing');
          resolve();
        }
      })();
    });
  }

  function stopAudio() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch {}
      currentAudio = null;
    }
  }

  function loadAudio(base64, mime) {
    return new Promise(resolve => {
      let done = false;
      const finish = a => { if (!done) { done = true; resolve(a); } };
      const a = new Audio(`data:${mime || 'audio/wav'};base64,${base64}`);
      a.addEventListener('loadedmetadata', () => finish(a));
      a.addEventListener('error', () => finish(null));
      setTimeout(() => finish(a), 1500);
    });
  }

  async function speakLine(bodyEl, text, tts) {
    let audio = null;
    let durMs = 0;
    if (tts && tts.ok) {
      audio = await loadAudio(tts.base64, tts.mime);
      if (audio && isFinite(audio.duration) && audio.duration > 0) durMs = audio.duration * 1000;
    }
    const pace = durMs ? Math.max(14, Math.min(55, (durMs * 0.92) / Math.max(1, text.length))) : 24;
    const tw = typewriter(bodyEl, text, pace);
    let ap = Promise.resolve();
    if (audio && !abort) {
      currentAudio = audio;
      ap = new Promise(res => {
        audio.addEventListener('ended', res);
        audio.addEventListener('error', res);
        audio.play().catch(res);
      });
    }
    await Promise.all([tw, ap]);
    currentAudio = null;
  }

  function toggleRun(on) {
    running = on;
    $('btn-run').disabled = on;
    $('btn-run').hidden = on;
    $('btn-stop').hidden = !on;
  }

  async function runDuet() {
    if (running) return;
    if (!currentMode) { setStatus(t('st_pickmode'), 'warn'); return; }
    if (!source && !$('src-input').value.trim()) {
      source = { kind: 'text', name: 'daily seed', text: defaultFocus(), truncated: false };
      $('src-chip').textContent = t('chip_text', { name: source.name, n: source.text.length });
      $('src-chip').className = 'src-chip ok';
    } else if (!source) {
      await loadSource();
      if (!source) return;
    }

    abort = false;
    toggleRun(true);
    clearLog();
    if (bridge && settings.provider === 'lmstudio') {
      setStatus(t('st_warming', { m: modelId() }));
      await warmModelSilently();
    }
    const voice = bridge && settings.voiceOn;
    if (voice) await preflightVram();

    const transcript = [];
    const turns = Math.max(2, Math.min(12, parseInt($('turns').value, 10) || 6));
    let speaker = MODES[currentMode].first;
    for (let i = 0; i < turns && !abort; i++) {
      const name = PERSONAS[speaker].name;
      setSpeaking(speaker, true);
      $('log-tag').textContent = '[ ' + t('w_composing', { name }) + ' ]';
      setStatus(t('st_composing', { name, i: i + 1, n: turns }));
      const r = await llmChat(buildMessages(speaker, currentMode, transcript, i === 0));
      if (abort) { setSpeaking(speaker, false); break; }
      if (!r.ok) {
        setSpeaking(speaker, false);
        setStatus(t('st_llmerr', { e: r.error }), 'err');
        $('log-tag').textContent = tag('tag_error');
        toggleRun(false);
        return;
      }
      const text = (r.text || '').trim() || '...';
      let tts = null;
      if (voice) {
        $('log-tag').textContent = '[ ' + t('w_voicing', { name }) + ' ]';
        tts = await bridge.ttsGenerate({
          baseURL: settings.voiceURL,
          text,
          voice_design: VOICE_DESIGN[speaker],
          seed: VOICE_SEED[speaker],
          language: langMeta().voxcpm
        });
        if (!tts.ok) setStatus(t('st_voiceerr', { e: tts.error }), 'warn');
      }
      if (abort) { setSpeaking(speaker, false); break; }

      $('log-tag').textContent = '[ ' + t('w_speaking', { name }) + ' ]';
      const bodyEl = appendMsgShell(speaker, currentMode);
      await speakLine(bodyEl, text, tts);
      bodyEl.parentElement.querySelector('.msg-copy').disabled = !text || text === '...';
      setSpeaking(speaker, false);
      transcript.push({ speaker, text });
      if (abort) break;
      speaker = speaker === 'tsuki' ? 'selene' : 'tsuki';
    }
    stopAudio();
    $('log-tag').textContent = abort ? tag('tag_stopped') : tag('tag_done');
    toggleRun(false);
    setStatus(
      abort ? t('st_stopped', { n: transcript.length }) : t('st_done', { n: transcript.length, mode: modeName(currentMode) }),
      abort ? 'warn' : 'ok'
    );
  }

  function renderVram(r) {
    const el = $('vram');
    if (!el) return;
    if (!r || !r.ok || !r.available) {
      el.className = 'vram off';
      el.textContent = 'VRAM -';
      el.title = (r && (r.error || r.reason)) || 'Local TTS telemetry offline';
      return;
    }
    el.className = 'vram' + (r.warning ? ' warn' : ' ok');
    el.textContent = `VRAM ${r.used_gib}/${r.total_gib} GB`;
    el.title = `${r.device_name || 'GPU'} · free ${r.free_gib} GB · voice needs ~${r.estimated_required_gib} GB`;
  }

  async function pollVram() {
    if (!bridge) return;
    renderVram(await bridge.vramTelemetry(settings.voiceURL));
  }

  async function preflightVram() {
    const r = await bridge.vramTelemetry(settings.voiceURL);
    renderVram(r);
    if (r && r.ok && r.available && r.warning) {
      setStatus(`Low VRAM: ${r.free_gib} GB free, voice needs ~${r.estimated_required_gib} GB.`, 'warn');
      await new Promise(res => setTimeout(res, 1200));
    }
  }

  async function loadSource() {
    const raw = $('src-input').value;
    if (!raw.trim()) { setStatus(t('st_loadsrc'), 'warn'); return; }
    if (bridge) {
      const r = await bridge.readSource(raw);
      if (!r.ok) {
        setStatus(r.error, 'err');
        $('src-chip').textContent = t('chipnone');
        $('src-chip').className = 'src-chip';
        return;
      }
      source = r;
      if (r.kind === 'image') {
        $('src-chip').textContent = t('chip_img', { name: r.name, kb: Math.round(r.bytes / 1024) });
        $('src-chip').className = 'src-chip img';
      } else {
        $('src-chip').textContent = t('chip_text', { name: r.name, n: r.text.length }) + (r.truncated ? ' ...' : '');
        $('src-chip').className = 'src-chip ok';
      }
      setStatus(t('st_srcloaded'), 'ok');
    } else {
      source = { kind: 'text', name: '(pasted text)', text: raw.trim(), truncated: false };
      $('src-chip').textContent = t('chip_text', { name: source.name, n: source.text.length });
      $('src-chip').className = 'src-chip ok';
      setStatus(t('st_srcloaded'), 'warn');
    }
  }

  function applySettingsToFields() {
    $('cfg-provider').value = settings.provider || 'lmstudio';
    $('cfg-url').value = settings.url;
    $('cfg-model').value = settings.model;
    $('cfg-temp').value = settings.temp;
    $('cfg-key').value = settings.key;
    $('cfg-voice-url').value = settings.voiceURL;
    $('cfg-voice-on').checked = !!settings.voiceOn;
    $('cfg-always-on-top').checked = !!settings.alwaysOnTop;
    $('lesson-level').value = lessonLevel;
  }

  async function applyWindowPreferences() {
    if (!bridge || !bridge.setAlwaysOnTop) return;
    try { await bridge.setAlwaysOnTop(!!settings.alwaysOnTop); } catch {}
  }

  function paintPrivacy(provider = settings.provider) {
    const note = $('privacy-note');
    if (note) note.textContent = t(provider === 'openrouter' ? 'privacy_cloud' : 'privacy_local');
  }

  function setActiveMode() {
    document.querySelectorAll('#modes .mode').forEach(m => m.classList.toggle('active', m.dataset.mode === currentMode));
    document.querySelector('.app').dataset.mode = currentMode || '';
  }

  $('gear').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  $('cfg-provider').addEventListener('change', e => {
    const p = PROVIDERS[e.target.value] || {};
    if (p.url) $('cfg-url').value = p.url;
    $('cfg-key').placeholder = p.keyHint || 'lm-studio';
    $('cfg-model').placeholder = p.modelHint || 'loaded local model';
    paintPrivacy(e.target.value);
  });
  $('cfg-always-on-top').addEventListener('change', event => {
    settings.alwaysOnTop = !!event.target.checked;
    localStorage.setItem('gengo-settings', JSON.stringify(settings));
    applyWindowPreferences();
  });
  $('cfg-save').addEventListener('click', () => {
    settings = {
      provider: $('cfg-provider').value,
      url: $('cfg-url').value.trim() || DEFAULTS.url,
      model: $('cfg-model').value.trim(),
      temp: $('cfg-temp').value || 0.55,
      key: $('cfg-key').value.trim() || 'lm-studio',
      voiceURL: $('cfg-voice-url').value.trim() || DEFAULTS.voiceURL,
      voiceOn: $('cfg-voice-on').checked,
      alwaysOnTop: $('cfg-always-on-top').checked
    };
    localStorage.setItem('gengo-settings', JSON.stringify(settings));
    modelWarmPromise = null;
    applyWindowPreferences();
    paintPrivacy();
    $('cfg-status').textContent = t('saved');
    setTimeout(() => { $('cfg-status').textContent = ''; }, 1500);
    checkConnection();
    pollVram();
  });

  $('btn-load').addEventListener('click', loadSource);
  (function wireMinimize() {
    const btn = $('btn-minimize'); if (!btn) return;
    if (!bridge || !bridge.minimizeWindow) { btn.hidden = true; return; }
    btn.addEventListener('click', () => bridge.minimizeWindow());
  })();
  (function wireScreenToggle() {
    const btn = $('screen-toggle'); if (!btn) return;
    if (!bridge || !bridge.moveWindow) { btn.hidden = true; return; }
    const label = $('screen-toggle-label');
    const paint = location => {
      const onMain = location === 'main';
      if (label) label.textContent = onMain ? t('scr_side') : t('scr_main');
      btn.classList.toggle('active', onMain);
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { const result = await bridge.moveWindow(); if (result?.ok) paint(result.location); }
      finally { btn.disabled = false; }
    });
    bridge.windowLocation?.().then(result => { if (result?.ok) paint(result.location); });
  })();
  const loadModelBtn = $('btn-loadmodel');
  if (loadModelBtn) loadModelBtn.addEventListener('click', async () => {
    if (!bridge || !bridge.llmLoad) { setStatus(t('st_loadelectron'), 'warn'); return; }
    if (settings.provider !== 'lmstudio') { setStatus(t('st_loadlocal'), 'warn'); return; }
    loadModelBtn.disabled = true;
    setStatus(t('st_modelloading', { m: modelId() }));
    try {
      const result = await bridge.llmLoad({ baseURL: settings.url, apiKey: settings.key, model: modelId() });
      modelWarmPromise = Promise.resolve(result);
      setStatus(result.ok ? t(result.status === 'already' ? 'st_modelalready' : 'st_modelloaded', { m: result.model || modelId() }) : t('st_modelerr', { e: result.error || 'unknown error' }), result.ok ? 'ok' : 'err');
      if (result.ok) checkConnection();
    } finally { loadModelBtn.disabled = false; }
  });
  $('btn-copy-all').addEventListener('click', async () => {
    const text = [...document.querySelectorAll('.msg')].map(message => {
      const who = message.querySelector('.msg-name').textContent.replace(/\s*·.*$/, '').trim();
      return `${who}: ${message.querySelector('.msg-body').textContent.trim()}`;
    }).filter(Boolean).join('\n\n');
    if (await copyText(text)) { $('btn-copy-all').textContent = t('copied'); setTimeout(() => { $('btn-copy-all').textContent = t('copy_all'); }, 1200); }
  });
  $('btn-run').addEventListener('click', runDuet);
  $('btn-stop').addEventListener('click', () => {
    abort = true;
    stopAudio();
    setStatus(t('st_stopping'), 'warn');
  });
  $('lesson-level').addEventListener('change', e => {
    lessonLevel = e.target.value;
    localStorage.setItem('gengo-level', lessonLevel);
    if (source && source.name === 'daily seed') {
      source = null;
      $('src-chip').textContent = t('chipnone');
      $('src-chip').className = 'src-chip';
    }
  });
  document.querySelectorAll('#modes .mode').forEach(m => m.addEventListener('click', () => {
    currentMode = m.dataset.mode;
    localStorage.setItem('gengo-mode', currentMode);
    setActiveMode();
    setStatus(t('st_modeset', { mode: modeName(currentMode) }), 'ok');
  }));
  document.querySelectorAll('.theme-swatch').forEach(btn => btn.addEventListener('click', () => {
    theme = btn.dataset.theme;
    localStorage.setItem('gengo-theme', theme);
    applyTheme();
  }));

  function renderEmptyLog() {
    if (!$('log').querySelector('.msg')) {
      $('log').innerHTML = `<div class="log-empty">言 ${esc(t('empty'))}</div>`;
    }
  }
  function refreshDynamicI18n() {
    if (!running) $('log-tag').textContent = tag('tag_idle');
    if (!source) $('src-chip').textContent = t('chipnone');
    renderEmptyLog();
    checkConnection();
  }

  (function buildLangSelect() {
    const sel = $('lang-select');
    sel.innerHTML = LANGS.map(l => `<option value="${l.code}">${l.native}</option>`).join('');
    sel.value = lang;
    sel.addEventListener('change', e => {
      lang = e.target.value;
      localStorage.setItem('gengo-lang', lang);
      applyStaticI18n();
      refreshDynamicI18n();
    });
  })();

  document.querySelectorAll('.credit-link').forEach(a => a.addEventListener('click', event => {
    const url = a.dataset.url;
    if (!url) return;
    event.preventDefault();
    if (bridge) bridge.openURL(url);
    else window.open(url, '_blank', 'noopener');
  }));

  applyTheme();
  applyStaticI18n();
  applySettingsToFields();
  applyWindowPreferences();
  paintPrivacy();
  setActiveMode();
  $('log-tag').textContent = tag('tag_idle');
  $('src-chip').textContent = t('chipnone');
  renderEmptyLog();
  checkConnection();
  if (bridge) {
    $('filebanner').hidden = true;
    pollVram();
    setInterval(pollVram, 6000);
  } else {
    $('filebanner').hidden = false;
    $('filebanner').textContent = t('browser_banner');
  }
})();
