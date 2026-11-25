'use strict';
/* ===== Helpers & storage ===== */
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast('Browser storage is unavailable.', 'error'); return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } }
};
const PRESETS = {
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/auto' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-20b' }, // Llama 3.1/3.3 were shut down on Groq 2026-08-16
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-flash-latest' },
  mistral: { endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  custom: { endpoint: '', model: '' }
};
const SUGG = ['How do I find diamonds?', 'Build me a Minecraft castle.', 'How do I defeat the Ender Dragon?', 'Explain redstone circuits.', 'What are the best survival tips?'];
const DEMO = {
  diamond: '**Finding diamonds**\n- Dig down to about Y=-59 and strip mine in a straight line.\n- Bring an iron pickaxe and a water bucket for lava.\n- Caves with exposed ore are faster than digging blind.',
  castle: '**Castle starter**\nRun this to raise a hollow keep:\n```\n/fill ~ ~ ~ ~12 ~8 ~12 stone_bricks hollow\n```\nAdd corner towers, a gate and battlements next.',
  ender: '**Ender Dragon plan**\n- Craft Eyes of Ender and find the stronghold.\n- Destroy the end crystals first (bow works well).\n- Hit the dragon when it perches on the portal.\n- Bring blocks, a water bucket and good armor.',
  redstone: '**Redstone basics**\n- Dust carries power up to 15 blocks.\n- Torches invert signals.\n- Repeaters boost and delay; comparators measure and compare.\nStart with a lever, dust and a lamp.',
  survival: '**Survival tips**\n- Build a shelter before the first night.\n- Always carry food and a bed.\n- Light up caves with torches.\n- Never dig straight down.',
  default: 'Ho there, Minecrafter! Ask me about mining, building, redstone or bosses.'
};

/* ===== State ===== */
let chats = LS.get('mc_chats', []);
let currentId = LS.get('mc_current', null);
let xp = LS.get('mc_xp', 0);
let muted = LS.get('mc_mute', false);
let cfg = { provider: 'openai', ...PRESETS.openai, persist: false, ...LS.get('mc_cfg', {}) };
let apiKey = cfg.persist ? LS.get('mc_key', '') : '';   // memory-only unless user opted in
let aborter = null;
// Models Groq has shut down: swap a saved one for the current default so old settings don't break
const DEAD_MODELS = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'moonshotai/kimi-k2-instruct-0905'];
const modelMigrated = cfg.provider === 'groq' && DEAD_MODELS.includes(cfg.model);
if (modelMigrated) { cfg.model = PRESETS.groq.model; LS.set('mc_cfg', cfg); }

const cur = () => chats.find(c => c.id === currentId);
const save = () => LS.set('mc_chats', chats);
const mkBtn = (t, label, fn) => { const b = document.createElement('button'); b.textContent = t; b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; return b; };
const mask = k => k.length > 8 ? k.slice(0, 3) + '........' + k.slice(-4) : '........';

/* ===== Feedback: toasts, sound, XP ===== */
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = (type === 'ach' ? 'Achievement: ' : '') + msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function beep(freq = 520) {
  if (muted) return;
  try {
    const a = beep.ctx || (beep.ctx = new AudioContext()), o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.08);
  } catch { /* audio unavailable */ }
}
function renderXp() { $('#xpFill').style.width = (xp % 100) + '%'; $('#xpLvl').textContent = 'Lv ' + (Math.floor(xp / 100) + 1); }
function addXp(n) {
  const before = Math.floor(xp / 100);
  xp += n; LS.set('mc_xp', xp);
  if (Math.floor(xp / 100) > before) { toast('Level up! You reached Lv ' + (before + 2), 'ach'); beep(880); }
  renderXp();
}

/* ===== Rendering ===== */
function md(s) { // tiny markdown: code blocks, inline code, bold, headings, bullets
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.split(/(```[\s\S]*?```)/g).map((p, i) => i % 2
    ? `<pre><code>${esc(p.replace(/^```\w*\n?/, '').replace(/```$/, ''))}</code></pre>`
    : esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,3} (.+)$/gm, '<h4>$1</h4>').replace(/^[-*] /gm, '\u2022 ').replace(/\n/g, '<br>')).join('');
}
function renderList() {
  const q = $('#search').value.toLowerCase(), ul = $('#chatList');
  ul.innerHTML = '';
  chats.filter(c => c.title.toLowerCase().includes(q) || c.messages.some(m => m.content.toLowerCase().includes(q))).forEach(c => {
    const li = document.createElement('li');
    if (c.id === currentId) li.className = 'on';
    const t = mkBtn(c.title, 'Open ' + c.title, () => { currentId = c.id; LS.set('mc_current', c.id); render(); closeDrawer(); });
    t.className = 'ttl'; t.textContent = c.title;
    const r = mkBtn('Ren', 'Rename conversation', () => {
      const n = prompt('Rename conversation', c.title);
      if (n && n.trim()) { c.title = n.trim().slice(0, 40); save(); renderList(); }
    });
    const d = mkBtn('X', 'Delete conversation', () => {
      if (!confirm('Delete this conversation?')) return;
      chats = chats.filter(x => x.id !== c.id);
      if (currentId === c.id) currentId = chats[0] ? chats[0].id : null;
      save(); LS.set('mc_current', currentId); render();
    });
    li.append(t, r, d); ul.append(li);
  });
}
function msgEl(m, last) {
  const w = document.createElement('div'); w.className = 'msg ' + m.role + (m.error ? ' err' : '');
  const av = document.createElement('div'); av.className = 'av ' + m.role; av.textContent = m.role === 'user' ? 'S' : '';
  const b = document.createElement('div'); b.className = 'bubble';
  const body = document.createElement('div'); body.innerHTML = md(m.content);
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ';
  meta.append(mkBtn('Copy', 'Copy message', () => navigator.clipboard.writeText(m.content).then(() => toast('Copied to inventory!'), () => toast('Copy failed.', 'error'))));
  if (m.role === 'assistant' && last) meta.append(mkBtn(m.error ? 'Retry' : 'Redo', m.error ? 'Retry request' : 'Regenerate response', regenerate));
  b.append(body, meta); w.append(av, b); return w;
}
function renderMsgs() {
  const box = $('#messages'), c = cur(); box.innerHTML = '';
  if (!c || !c.messages.length) {
    box.innerHTML = '<div class="welcome"><div class="diamond">&#9670;</div><h1>Welcome to Minecraft AI!</h1><p>Your adventure begins here. Ask me anything, Minecrafter!</p><div class="sugg"></div></div>';
    SUGG.forEach(q => { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = q; b.onclick = () => send(q); box.querySelector('.sugg').append(b); });
    return;
  }
  c.messages.forEach((m, i) => box.append(msgEl(m, i === c.messages.length - 1)));
  box.scrollTop = box.scrollHeight;
}
function typing(on) {
  const old = $('#typing'); if (old) old.remove();
  if (!on) return;
  const t = document.createElement('div'); t.id = 'typing'; t.className = 'msg assistant';
  t.innerHTML = '<div class="av assistant"></div><div class="bubble dots"><i></i><i></i><i></i></div>';
  $('#messages').append(t); t.scrollIntoView();
}
let connState = 'untested'; // 'untested' | 'ok' | 'fail'
function updateStatus() {
  const s = $('#status');
  s.textContent = !apiKey ? 'Disconnected (demo)' : connState === 'ok' ? 'Connected' : connState === 'fail' ? 'Connection failed' : 'Key set (untested)';
  s.classList.toggle('on', !!apiKey && connState === 'ok');
}
function render() { renderList(); renderMsgs(); }

/* ===== Chat logic ===== */
function newChat() {
  const c = cur();
  if (c && !c.messages.length) return render();
  const n = { id: Date.now().toString(36), title: 'New Chat', messages: [] };
  chats.unshift(n); currentId = n.id; save(); LS.set('mc_current', currentId); render();
}
function setBusy(b) { aborter = b ? new AbortController() : null; $('#send').hidden = b; $('#stop').hidden = !b; }
function send(text) {
  text = (text === undefined ? $('#input').value : text).trim();
  if (!text || aborter) return;
  if (!cur()) newChat();
  const c = cur();
  c.messages.push({ role: 'user', content: text, time: Date.now() });
  if (c.title === 'New Chat') c.title = text.slice(0, 28);
  $('#input').value = ''; autosize(); save(); addXp(10); beep();
  if (!LS.get('mc_ach1', false)) { LS.set('mc_ach1', true); toast('Getting Wood: first message sent!', 'ach'); }
  reply();
}
function regenerate() {
  const c = cur(); if (!c || aborter) return;
  if (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  save(); reply();
}
async function reply() {
  const c = cur(); renderList(); renderMsgs(); typing(true); setBusy(true);
  let text, error = false;
  try {
    text = apiKey ? await request(cfg.endpoint, cfg.model, apiKey, history(c), aborter.signal) : await demo(c);
    if (apiKey) { connState = 'ok'; updateStatus(); }
  } catch (e) {
    error = true; text = e.name === 'AbortError' ? 'Generation stopped.' : friendly(e);
    if (e.name !== 'AbortError' && apiKey) { connState = 'fail'; updateStatus(); }
  }
  typing(false); setBusy(false);
  c.messages.push({ role: 'assistant', content: text, time: Date.now(), error });
  save(); renderMsgs(); if (!error) addXp(5); beep(660);
}
const history = c => [
  { role: 'system', content: 'You are Minecraft AI, a friendly Minecraft expert. Answer clearly with light Minecraft flavor and markdown.' },
  ...c.messages.filter(m => !m.error).map(({ role, content }) => ({ role, content }))
];
async function demo(c) {
  await new Promise(r => setTimeout(r, 900));
  const q = c.messages[c.messages.length - 1].content.toLowerCase();
  const k = Object.keys(DEMO).find(key => q.includes(key));
  return DEMO[k || 'default'] + '\n\nDemo mode: add an API key in API Config for real answers.';
}

/* ===== API (OpenAI-compatible chat completions) ===== */
async function request(endpoint, model, key, messages, signal, maxTokens) {
  const body = { model, messages, temperature: 0.7, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  } catch (e) { if (e.name === 'AbortError') throw e; const n = new Error('NETWORK'); n.raw = e.message; throw n; }
  if (!res.ok) { const e = new Error('HTTP'); e.status = res.status; e.detail = await res.json().then(d => (d.error && d.error.message) || '').catch(() => ''); throw e; }
  const data = await res.json().catch(() => null);
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) { if (maxTokens && data && data.choices) return ''; throw new Error('FORMAT'); } // tests only need a valid reply
  return out;
}
const friendly = e => friendlyBase(e) + (e.detail ? '\n\nServer said: ' + String(e.detail).slice(0, 200) + (/model/i.test(e.detail) ? ' (Open API Config and press Load models to pick an active model.)' : '') : '');
function friendlyBase(e) {
  const s = e.status;
  if (s === 401 || s === 403) return '**Creeper!** The API rejected your key (HTTP ' + s + '). Check it in API Config.';
  if (s === 429) return '**Rate limit reached.** Wait a moment, then press Retry.';
  if (s === 404 || s === 405) return '**Lost in the Nether.** Endpoint not found or unsupported. Check the endpoint URL.';
  if (s >= 500) return '**The server exploded** (HTTP ' + s + '). Try again shortly.';
  if (s) return '**Request failed** (HTTP ' + s + '). Check the model name and endpoint.';
  if (e.message === 'NETWORK') return '**Network error' + (e.raw ? ' (' + e.raw + ')' : '') + '.** Check your connection. The endpoint may also block browser (CORS) requests.' + (location.protocol === 'file:' ? ' You opened the file directly: run "python -m http.server" in this folder and open http://localhost:8000 instead.' : '');
  if (e.message === 'FORMAT') return '**Unexpected response.** The endpoint may not be OpenAI-compatible.';
  return '**Something broke:** ' + e.message;
}

/* ===== API settings modal ===== */
const MODELS = {
  groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'groq/compound-mini', 'groq/compound'],
  gemini: ['gemini-flash-latest', 'gemini-pro-latest'],
  mistral: ['mistral-small-latest', 'mistral-large-latest'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  openrouter: ['openrouter/auto', 'openai/gpt-4o-mini'],
  custom: []
};
const fillModels = p => { $('#models').innerHTML = (MODELS[p] || []).map(m => `<option value="${m}">`).join(''); };
// Groq keys always start with "gsk_"; catch pasted keys from the wrong provider early
const keyProblem = (p, k) => p === 'groq' && !k.startsWith('gsk_') ? 'Groq keys start with "gsk_". Check the key you pasted.' : '';
const setModalStatus = (t, cls) => { const m = $('#mstatus'); m.textContent = t; m.style.color = cls === 'ok' ? '#69f0ae' : cls === 'bad' ? '#ff8a80' : ''; };
function openApi() {
  $('#provider').value = cfg.provider; fillModels(cfg.provider); $('#endpoint').value = cfg.endpoint; $('#model').value = cfg.model;
  $('#persist').checked = cfg.persist; $('#key').value = ''; $('#key').type = 'password'; $('#showKey').textContent = 'Show';
  $('#key').placeholder = apiKey ? 'Saved: ' + mask(apiKey) + ' (type to replace)' : 'Paste your API key';
  setModalStatus(apiKey ? 'Key set (not tested)' : 'No key'); $('#modal').hidden = false; $('#key').focus();
}
const closeApi = () => {
  if ($('#modal').hidden) return;
  if ($('#key').value.trim()) toast('You typed a key but did not press Save, so it was not stored.', 'error');
  $('#modal').hidden = true;
};
const applyProvider = p => {
  fillModels(p);
  if (p !== 'custom') { $('#endpoint').value = PRESETS[p].endpoint; $('#model').value = PRESETS[p].model; }
  if (apiKey && p !== cfg.provider) setModalStatus('Paste a key for ' + p + ' (saved key is for ' + cfg.provider + ')');
};
$('#provider').onchange = e => applyProvider(e.target.value);
$('#groqQuick').onclick = () => { $('#provider').value = 'groq'; applyProvider('groq'); $('#key').focus(); setModalStatus('Paste your Groq key (starts with gsk_)'); };
$('#showKey').onclick = () => { const k = $('#key'), show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('#showKey').textContent = show ? 'Hide' : 'Show'; };
const cleanKey = k => k.replace(/^["']|["']$/g, '').replace(/\s+/g, '');
const checkKey = (prov, k) => /[^\x21-\x7E]/.test(k) ? 'The key has invalid characters. Copy it again from the provider console.' : keyProblem(prov, k);
// Sends one tiny real request with the form's current values and reports the exact result
async function runTest(key) {
  setModalStatus('Testing...');
  try {
    await request($('#endpoint').value.trim(), $('#model').value.trim(), key, [{ role: 'user', content: 'Reply with OK' }], undefined, 8);
    if (key === apiKey) { connState = 'ok'; updateStatus(); }
    setModalStatus('Connected', 'ok'); return true;
  } catch (e) {
    if (key === apiKey) { connState = 'fail'; updateStatus(); }
    const msg = friendly(e).replace(/\*/g, '').replace(/\n+/g, ' ');
    setModalStatus('Failed: ' + msg, 'bad'); toast(msg.slice(0, 180), 'error'); return false;
  }
}
$('#saveApi').onclick = async () => {
  const endpoint = $('#endpoint').value.trim(), model = $('#model').value.trim(), typed = cleanKey($('#key').value), prov = $('#provider').value;
  if (!/^https?:\/\//i.test(endpoint)) return toast('Enter a valid http(s) endpoint URL.', 'error');
  if (!model) return toast('Model name is required.', 'error');
  if (!typed && !apiKey) return toast('API key cannot be empty.', 'error');
  if (!typed && prov !== cfg.provider) return toast('Paste a ' + prov + ' key: the saved key belongs to ' + cfg.provider + '.', 'error');
  const bad = typed && checkKey(prov, typed);
  if (bad) return toast(bad, 'error');
  if (typed) apiKey = typed;
  cfg = { provider: prov, endpoint, model, persist: $('#persist').checked };
  if (!cfg.persist) LS.del('mc_key');
  else if (!LS.set('mc_key', apiKey)) { cfg.persist = false; $('#persist').checked = false; }
  LS.set('mc_cfg', cfg);
  connState = 'untested'; $('#key').value = ''; $('#key').placeholder = 'Saved: ' + mask(apiKey) + ' (type to replace)';
  updateStatus();
  toast(cfg.persist ? 'Key saved in this browser.' : 'Key saved for this session only. It is cleared on reload unless you tick the localStorage box.');
  if (await runTest(apiKey)) { closeApi(); toast('Connected!'); }
};
$('#testApi').onclick = async () => {
  const key = cleanKey($('#key').value) || apiKey;
  if (!key) return toast('Enter an API key first.', 'error');
  const bad = checkKey($('#provider').value, key);
  if (bad) return toast(bad, 'error');
  if (await runTest(key)) toast('Connection successful!');
};
// Lists the models your key can actually use (fixes "model not found" errors)
$('#loadModels').onclick = async () => {
  const key = cleanKey($('#key').value) || apiKey;
  if (!key) return toast('Enter an API key first.', 'error');
  setModalStatus('Loading models...');
  try {
    const res = await fetch($('#endpoint').value.trim().replace(/\/chat\/completions\/?$/, '/models'), { headers: { Authorization: 'Bearer ' + key } });
    if (!res.ok) { const e = new Error('HTTP'); e.status = res.status; throw e; }
    const ids = ((await res.json()).data || []).map(m => String(m.id || '').replace(/^models\//, '')).filter(id => id && !/whisper|tts|orpheus|guard|embed/i.test(id));
    $('#models').replaceChildren(...ids.map(id => { const o = document.createElement('option'); o.value = id; return o; }));
    setModalStatus(ids.length + ' models loaded. Click the Model field to pick one.', 'ok');
  } catch (e) { setModalStatus('Could not load models: ' + friendly(e).replace(/\*/g, ''), 'bad'); }
};
$('#removeKey').onclick = () => { apiKey = ''; LS.del('mc_key'); $('#key').value = ''; $('#key').placeholder = 'Paste your API key'; updateStatus(); setModalStatus('No key'); toast('API key removed.'); };
$('#closeApi').onclick = closeApi;
$('#modal').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') $('#saveApi').click(); });
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeApi(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeApi(); });

/* ===== UI wiring ===== */
const closeDrawer = () => document.body.classList.remove('drawer');
const autosize = () => { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 150) + 'px'; };
$('#send').onclick = () => send();
$('#stop').onclick = () => { if (aborter) aborter.abort(); };
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#newChat').onclick = () => { newChat(); closeDrawer(); };
$('#search').addEventListener('input', renderList);
$('#openApi').onclick = openApi;
$('#menuBtn').onclick = () => document.body.classList.toggle(innerWidth <= 800 ? 'drawer' : 'collapsed');
$('main').addEventListener('click', closeDrawer);
$('#themeBtn').onclick = () => { const day = document.body.classList.toggle('day'); LS.set('mc_theme', day ? 'day' : 'night'); };
const syncSound = () => { $('#soundBtn').textContent = 'Sound: ' + (muted ? 'off' : 'on'); };
$('#soundBtn').onclick = () => { muted = !muted; LS.set('mc_mute', muted); syncSound(); beep(); };
$('#clearAll').onclick = () => {
  if (!confirm('Clear ALL chat history? This cannot be undone.')) return;
  chats = []; currentId = null; save(); LS.set('mc_current', null); render(); toast('Chat history cleared.');
};
$('#clearChat').onclick = () => {
  const c = cur(); if (!c || !c.messages.length || !confirm('Clear this conversation?')) return;
  c.messages = []; c.title = 'New Chat'; save(); render();
};

/* ===== Init ===== */
for (let i = 0; i < 24; i++) { // floating particles
  const p = document.createElement('i');
  p.style.cssText = `left:${Math.random() * 100}%;animation-duration:${6 + Math.random() * 10}s;animation-delay:-${Math.random() * 10}s;background:${['#00C853', '#42D9FF', '#5D9B35'][i % 3]}`;
  $('#particles').append(p);
}
if (LS.get('mc_theme', 'night') === 'day') document.body.classList.add('day');
syncSound(); renderXp(); updateStatus(); render();
if (modelMigrated) toast('Groq retired your saved model. Switched to ' + cfg.model + '.');
setTimeout(() => $('#loader').classList.add('gone'), 1000);
