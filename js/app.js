// PDF圧縮：画面処理
import { PRESETS, DEFAULT_SETTINGS, TARGET_LEVELS, compressArgs, renderArgs, outputName, inspect, formatBytes, searchTarget, qualityLabel } from './options.js';
import { makeZip } from './zip.js';

const $ = s => document.querySelector(s);
const WASM_SIZE = 15533045;   // vendor/ghostpdl-wasm/gs.wasm の大きさ（読み込みの進捗表示に使う。更新したら合わせる）
const STORE_KEY = 'pdfcomp-v1';

// ---------- 表示テーマ（QC Workbench 共通） ----------
const THEME_KEY = 'qc-workbench-theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '表示：自動', light: '表示：ライト', dark: '表示：ダーク' };
function readTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return THEMES.includes(t) ? t : 'auto'; } catch (e) { return 'auto'; }
}
let theme = readTheme();
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = THEME_LABEL[t];
}
$('#themeBtn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % 3];
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 保存できない環境 */ }
  applyTheme(theme);
});
window.addEventListener('storage', e => { if (e.key === THEME_KEY || e.key === null) { theme = readTheme(); applyTheme(theme); } });
applyTheme(theme);

// ---------- タブ ----------
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  window.scrollTo(0, 0);
}));

// ---------- お知らせ ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---------- 設定 ----------
const MB = 1048576;
const TARGET_CHIPS = [1, 2, 3, 5, 10];   // よく使う上限（MB）。メール添付やシステムの制限によくある値
let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) { /* 壊れた保存値は無視 */ }
if (!PRESETS[settings.preset]) settings.preset = DEFAULT_SETTINGS.preset;
if (settings.mode !== 'target') settings.mode = 'preset';
if (!(settings.target > 0)) settings.target = DEFAULT_SETTINGS.target;

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* 保存できない環境 */ }
}
function settingsKey(s) { return JSON.stringify(s.mode === 'target' ? ['target', s.target, s.gray] : ['preset', s.preset, s.dpi, s.gray]); }
// 上限の表示（MB、小数第 2 位まで、末尾の 0 は省く）
function mbText(bytes) { return `${Number((bytes / MB).toFixed(2))} MB`; }

document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => { settings.mode = b.dataset.mode; onSettingsChanged(); }));

const presetBox = $('#presets');
for (const [key, p] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.preset = key;
  b.innerHTML = `${p.label}<small>${p.dpi} dpi</small>`;
  b.addEventListener('click', () => { settings.preset = key; onSettingsChanged(); });
  presetBox.append(b);
}
for (const v of TARGET_CHIPS) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.mb = String(v); b.textContent = `${v} MB`;
  b.addEventListener('click', () => { settings.target = v * MB; onSettingsChanged(); });
  $('#targetChips').append(b);
}
$('#target').addEventListener('change', e => {
  const v = Number(e.target.value);
  if (v > 0) settings.target = Math.round(v * MB); else toast('上限は 0 より大きい値を入れてください');
  onSettingsChanged();
});
$('#dpi').addEventListener('change', e => { settings.dpi = Number(e.target.value); onSettingsChanged(); });
$('#gray').addEventListener('change', e => { settings.gray = e.target.checked; onSettingsChanged(); });
$('#keepSmaller').addEventListener('change', e => { settings.keepSmaller = e.target.checked; onSettingsChanged(); items.forEach(renderItem); updateSummary(); });

function renderSettings() {
  const target = settings.mode === 'target';
  document.querySelectorAll('#modes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
  $('#presetPanel').hidden = target;
  $('#targetPanel').hidden = !target;
  // 目標サイズのときは解像度を自動で選ぶので、解像度の指定は出さない
  $('#dpiField').hidden = target;
  $('#dpiHint').hidden = target;
  presetBox.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === settings.preset)));
  const p = PRESETS[settings.preset];
  let d = p.desc;
  if (settings.dpi) d += `（詳細設定により、画像は ${settings.dpi} dpi に縮小します）`;
  if (settings.gray) d += '。色はすべて白黒（グレースケール）になります';
  $('#presetDesc').textContent = d;
  if (document.activeElement !== $('#target')) $('#target').value = String(Number((settings.target / MB).toFixed(2)));
  $('#targetChips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.mb) * MB === settings.target)));
  $('#dpi').value = String(settings.dpi);
  $('#gray').checked = settings.gray;
  $('#keepSmaller').checked = settings.keepSmaller;
  if ((settings.dpi && !target) || settings.gray || !settings.keepSmaller) $('#more').open = true;
}
function onSettingsChanged() {
  saveSettings();
  renderSettings();
  updateSummary();
}
renderSettings();

// ---------- エンジン（ワーカー） ----------
let worker = null, engineReady = false, jobSeq = 0;
const jobs = new Map();   // id → { resolve, onProgress }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'load') {
      showEngine(`圧縮エンジンを読み込んでいます… ${formatBytes(m.loaded)} / ${formatBytes(m.total)}`, m.total ? m.loaded / m.total : 0);
    } else if (m.type === 'ready') {
      engineIsReady();
    } else if (m.type === 'loadError') {
      showEngine(`圧縮エンジンを読み込めませんでした：${m.message}`, null, true);
    } else if (m.type === 'progress') {
      jobs.get(m.id)?.onProgress?.(m.page, m.pages);
    } else if (m.type === 'result') {
      if (!engineReady && m.code !== 'crash') engineIsReady();
      const j = jobs.get(m.id);
      jobs.delete(m.id);
      j?.resolve(m);
    }
  };
  worker.onerror = ev => {
    // ワーカー自体が落ちた場合（モジュールの読み込み失敗など）
    for (const j of jobs.values()) j.resolve({ ok: false, code: 'crash', message: ev.message || 'ワーカーが停止しました', log: [] });
    jobs.clear();
    showEngine(`圧縮エンジンを起動できませんでした：${ev.message || '不明なエラー'}`, null, true);
    worker = null;
  };
  return worker;
}
function engineIsReady() {
  engineReady = true;
  showEngine('圧縮エンジンの準備ができています。', null);
}
function showEngine(text, ratio, isError = false) {
  $('#engineText').textContent = text;
  $('#engineText').style.color = isError ? 'var(--ng)' : '';
  const bar = $('#engineBar');
  bar.hidden = ratio == null;
  if (ratio != null) bar.firstElementChild.style.width = `${Math.round(ratio * 100)}%`;
}
// Ghostscript を 1 回実行する（ワーカーは 1 つで、依頼は順番に処理される）
function runGs(args, inputs, outputs, onProgress) {
  const id = ++jobSeq;
  return new Promise(resolve => {
    jobs.set(id, { resolve, onProgress });
    getWorker().postMessage({ type: 'run', id, args, inputs, outputs, expectedSize: WASM_SIZE });
  });
}
function stopWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  engineReady = false;
  for (const j of jobs.values()) j.resolve({ ok: false, code: 'stopped', message: '中止しました', log: [] });
  jobs.clear();
  showEngine('中止しました。次に圧縮するときにエンジンを読み込み直します。', null);
}

// ---------- ファイル一覧 ----------
// item: { id, file, info, status, settings, result(Blob), pages, page, password, error, log, el }
//   status: queued | running | done | nogain | password | badpassword | error | stopped
const items = [];
let itemSeq = 0, busy = false;

async function addFiles(fileList) {
  const pdfs = [...fileList].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const skipped = fileList.length - pdfs.length;
  if (skipped) toast(`PDF ではないファイル ${skipped} 件は除きました`);
  if (!pdfs.length) return;
  $('#resultBox').hidden = false;
  for (const f of pdfs) {
    const it = { id: ++itemSeq, file: f, status: 'queued', info: null, pages: 0, page: 0 };
    items.push(it);
    createItemEl(it);
    try {
      it.info = inspect(new Uint8Array(await f.arrayBuffer()));
      if (!it.info.pdf) { it.status = 'error'; it.error = 'PDF ファイルとして読み取れません（先頭に %PDF- がありません）'; }
    } catch (e) {
      it.status = 'error'; it.error = `ファイルを読み込めません：${e.message || e}`;
    }
    renderItem(it);
  }
  updateSummary();
  processQueue();
}

async function processQueue() {
  if (busy) return;
  busy = true;
  $('#stopBtn').hidden = false;
  try {
    for (;;) {
      const it = items.find(x => x.status === 'queued');
      if (!it) break;
      await compressItem(it);
    }
  } finally {
    busy = false;
    $('#stopBtn').hidden = true;
    updateSummary();
  }
}

async function compressItem(it) {
  it.status = 'running'; it.page = 0; it.error = ''; it.log = null;
  it.settings = { ...settings };
  it.attempt = 0; it.attemptDpi = 0; it.level = null; it.result = null;
  renderItem(it);
  const s = it.settings;
  // 1 回圧縮する。失敗したら { failure } を投げる（目標サイズの探索を打ち切るため）
  const data = new Uint8Array(await it.file.arrayBuffer());
  const compressOnce = async level => {
    const r = await runGs(compressArgs(s, 'in.pdf', 'out.pdf', it.password, level), { 'in.pdf': data }, ['out.pdf'], (page, pages) => {
      it.page = page; it.pages = pages || it.pages;
      renderProgress(it);
    });
    it.log = r.log;
    if (!r.ok) throw { failure: r };
    it.pages = r.pages || it.pages;
    return { size: r.files['out.pdf'].length, out: r.files['out.pdf'] };
  };
  try {
    if (s.mode === 'target') {
      if (it.file.size <= s.target) {
        // もともと上限以下なら、画質を落とさないよう圧縮しない
        it.status = 'fits';
      } else {
        const found = await searchTarget(s.target, async i => {
          it.attempt++; it.attemptDpi = TARGET_LEVELS[i].dpi; it.page = 0;
          renderProgress(it);
          return compressOnce(TARGET_LEVELS[i]);
        });
        it.level = TARGET_LEVELS[found.index];
        it.attempts = found.attempts;
        it.result = new Blob([found.result.out], { type: 'application/pdf' });
        it.status = found.result.size >= it.file.size ? 'nogain' : found.reached ? 'done' : 'missed';
      }
    } else {
      const r = await compressOnce();
      it.result = new Blob([r.out], { type: 'application/pdf' });
      it.status = r.size >= it.file.size ? 'nogain' : 'done';
    }
  } catch (e) {
    const r = e.failure || { code: 'crash', message: String(e && e.message || e) };
    if (r.code === 'password' || r.code === 'badpassword') it.status = r.code;
    else if (r.code === 'stopped') it.status = 'stopped';
    else {
      it.status = 'error';
      it.error = r.code === 'memory' ? 'メモリが足りず圧縮できませんでした。ファイルが大きすぎる可能性があります' : r.message;
    }
  }
  renderItem(it);
  updateSummary();
}

// 保存に使えるか（ZIP に入れるか）
function usable(it) {
  return it.status === 'done' || it.status === 'missed' || (it.status === 'nogain' && !settings.keepSmaller);
}

// ---------- 一覧の表示 ----------
function createItemEl(it) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="fname"></div><span class="badge"></span>
    <div class="warns" hidden></div>
    <div class="itembar" hidden><div class="bar"><i></i></div></div>
    <div class="sizes" hidden></div>
    <div class="detail" hidden></div>
    <div class="err" hidden></div>
    <div class="actions"></div>
    <details class="log" hidden><summary>処理の記録</summary><pre></pre></details>`;
  it.el = li;
  $('#files').append(li);
}

const STATUS = {
  queued: ['待機中', ''], running: ['圧縮中', 'run'], done: ['完了', 'ok'], nogain: ['縮みませんでした', 'warn'],
  password: ['パスワードが必要', 'warn'], fits: ['上限以下（元のまま）', 'ok'], missed: ['上限に届かず', 'warn'], badpassword: ['パスワードが違います', 'ng'], error: ['失敗', 'ng'], stopped: ['中止', ''],
};

function renderItem(it) {
  const li = it.el;
  const name = li.querySelector('.fname');
  name.textContent = it.file.name;
  name.title = it.file.name;
  if (it.pages) { const s = document.createElement('span'); s.className = 'pages'; s.textContent = `${it.pages} ページ`; name.append(s); }

  const [label, cls] = STATUS[it.status];
  const badge = li.querySelector('.badge');
  badge.textContent = it.status === 'nogain' && !settings.keepSmaller ? '完了（大きくなりました）' : label;
  badge.className = `badge ${cls}`;

  // 注意事項
  const warns = [];
  if (it.info?.signed) warns.push('電子署名があります。圧縮すると署名は無効になります');
  if (it.info?.form) warns.push('入力欄は入力済みの値のまま固定されます');
  if (it.info?.encrypted && (it.status === 'done' || it.status === 'nogain')) {
    warns.push(it.password ? '圧縮後のファイルにはパスワードがかかりません' : '印刷・編集の制限は解除された状態で出力されます');
  }
  const w = li.querySelector('.warns');
  w.hidden = !warns.length;
  w.replaceChildren(...warns.map(t => { const s = document.createElement('span'); s.textContent = t; return s; }));

  li.querySelector('.itembar').hidden = it.status !== 'running';
  renderProgress(it);

  // サイズ
  const sizes = li.querySelector('.sizes');
  if (it.result) {
    const a = it.file.size, b = it.result.size;
    const rate = (1 - b / a) * 100;
    const grew = b >= a;
    sizes.hidden = false;
    sizes.innerHTML = `
      <span class="num">${formatBytes(a)}</span><span class="arrow">→</span><span class="num">${formatBytes(b)}</span>
      <span class="compare-bar ${grew ? 'warn' : ''}" title="圧縮後の大きさ（元を 100% とした割合）"><i style="width:${Math.min(100, b / a * 100).toFixed(1)}%"></i></span>
      <span class="rate ${grew ? 'warn' : 'ok'}">${grew ? `+${(-rate).toFixed(1)}%` : `−${rate.toFixed(1)}%`}</span>
      ${grew && settings.keepSmaller ? '<span class="hint">元のファイルのほうが小さいため、元のまま使ってください</span>' : ''}`;
  } else if (it.status !== 'running') {
    sizes.hidden = false;
    sizes.innerHTML = `<span class="num">${formatBytes(it.file.size)}</span>`;
  } else {
    sizes.hidden = true;
  }

  // 上限を決めて圧縮したときの内訳
  const detail = li.querySelector('.detail');
  let dt = '';
  const lim = it.settings?.mode === 'target' ? mbText(it.settings.target) : '';
  if (it.status === 'fits') dt = `上限 ${lim} 以下なので、圧縮せず元のまま使えます`;
  else if (lim && it.level && it.status === 'done') dt = `上限 ${lim} に収まる設定：画像 ${it.level.dpi} dpi・JPEG 画質「${qualityLabel(it.level.q)}」（${it.attempts} 回の圧縮で決定）`;
  else if (lim && it.level && it.status === 'missed') dt = `いちばん低い画質（画像 ${it.level.dpi} dpi・JPEG 画質「${qualityLabel(it.level.q)}」）でも上限 ${lim} に収まりませんでした。最も小さかった結果を表示しています。${it.settings.gray ? '' : '詳細設定で白黒にすると、さらに小さくなることがあります。'}ページを分けることも検討してください`;
  detail.hidden = !dt;
  detail.textContent = dt;

  const err = li.querySelector('.err');
  err.hidden = it.status !== 'error';
  err.textContent = it.error || '';

  // 操作
  const act = li.querySelector('.actions');
  act.replaceChildren();
  const btn = (text, fn, primary) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn small${primary ? ' primary' : ''}`; b.textContent = text;
    b.addEventListener('click', fn); act.append(b); return b;
  };
  const useResult = usable(it);
  if (useResult) btn('保存', () => download(it.result, outputName(it.file.name)), true);
  if (it.status === 'nogain' && settings.keepSmaller) btn('それでも圧縮結果を保存', () => download(it.result, outputName(it.file.name)));
  if (it.result) btn('画質を確認', () => openCompare(it));
  if (it.status === 'password' || it.status === 'badpassword') {
    const inp = document.createElement('input');
    inp.type = 'password'; inp.placeholder = '開くためのパスワード'; inp.autocomplete = 'off';
    inp.setAttribute('aria-label', `${it.file.name} のパスワード`);
    act.append(inp);
    const go = () => { if (!inp.value) { inp.focus(); return; } it.password = inp.value; it.status = 'queued'; renderItem(it); processQueue(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    btn('圧縮する', go, true);
  }
  if (it.status === 'error' || it.status === 'stopped') btn('もう一度', () => { it.status = 'queued'; renderItem(it); processQueue(); });
  if (it.status !== 'running') btn('一覧から消す', () => removeItem(it));

  const log = li.querySelector('details.log');
  log.hidden = !(it.log && it.log.length) || it.status === 'running';
  if (!log.hidden) log.querySelector('pre').textContent = it.log.join('\n');
}

function renderProgress(it) {
  if (it.status !== 'running') return;
  const bar = it.el.querySelector('.itembar .bar');
  const badge = it.el.querySelector('.badge');
  if (it.pages) {
    bar.classList.remove('indet');
    bar.firstElementChild.style.width = `${(it.page / it.pages * 100).toFixed(1)}%`;
    const trial = it.attempt ? `${it.attempt} 回目（${it.attemptDpi} dpi）` : '';
    badge.textContent = trial ? `探索 ${trial} ${it.page} / ${it.pages}` : `圧縮中 ${it.page} / ${it.pages} ページ`;
  } else {
    bar.classList.add('indet');
    badge.textContent = !engineReady ? 'エンジン読込中' : it.attempt ? `探索 ${it.attempt} 回目（${it.attemptDpi} dpi）` : '圧縮中';
  }
}

function removeItem(it) {
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  it.el.remove();
  if (!items.length) $('#resultBox').hidden = true;
  updateSummary();
}

function updateSummary() {
  const finished = items.filter(x => x.result);
  const use = finished.filter(usable);
  const before = finished.reduce((s, x) => s + x.file.size, 0);
  const after = finished.reduce((s, x) => s + (use.includes(x) ? x.result.size : x.file.size), 0);
  const total = $('#total');
  if (finished.length) {
    const rate = before ? (1 - after / before) * 100 : 0;
    total.innerHTML = `${finished.length} 件：<b>${formatBytes(before)}</b> → <b>${formatBytes(after)}</b>（${rate >= 0 ? '−' : '+'}${Math.abs(rate).toFixed(1)}%）`;
  } else {
    total.textContent = items.length ? `${items.length} 件` : '';
  }
  $('#zipBtn').disabled = !use.length || busy;
  // 圧縮したときの設定と今の設定が違うものがあれば「やり直す」を出す
  const now = settingsKey(settings);
  $('#rerunBtn').hidden = busy || !items.some(x => x.settings && settingsKey(x.settings) !== now && x.status !== 'error');
  const nogain = finished.filter(x => x.status === 'nogain' && settings.keepSmaller).length;
  const fits = items.filter(x => x.status === 'fits').length;
  const missed = items.filter(x => x.status === 'missed').length;
  const msgs = [];
  if (fits) msgs.push(`${fits} 件はもともと上限以下のため圧縮していません（保存・ZIP の対象外）。元のファイルをそのまま使ってください。`);
  if (nogain) msgs.push(`${nogain} 件は圧縮しても小さくならなかったため、保存（ZIP）に含めません。元のファイルをそのまま使ってください。`);
  if (missed) msgs.push(`${missed} 件は上限に収まりませんでした（最も小さくした結果は保存できます）。`);
  const notice = $('#notice');
  notice.hidden = !msgs.length;
  notice.textContent = msgs.join(' ');
}

// ---------- 保存 ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

$('#zipBtn').addEventListener('click', async () => {
  const list = items.filter(usable);
  if (!list.length) return;
  if (list.length === 1) { download(list[0].result, outputName(list[0].file.name)); return; }
  const used = new Set();
  const entries = [];
  for (const it of list) {
    // 同じ名前のファイルが複数あるときは (2) などを付ける
    let name = outputName(it.file.name), n = 1;
    while (used.has(name.toLowerCase())) name = outputName(it.file.name).replace(/\.pdf$/i, ` (${++n}).pdf`);
    used.add(name.toLowerCase());
    entries.push({ name, data: new Uint8Array(await it.result.arrayBuffer()) });
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  download(makeZip(entries, d), `compressed_${stamp}.zip`);
});

$('#rerunBtn').addEventListener('click', () => {
  for (const it of items) {
    if (it.status === 'error' || it.status === 'password' || it.status === 'badpassword') continue;
    it.status = 'queued'; it.result = null;
    renderItem(it);
  }
  updateSummary();
  processQueue();
});
$('#stopBtn').addEventListener('click', () => {
  for (const it of items) if (it.status === 'queued') { it.status = 'stopped'; renderItem(it); }
  stopWorker();
});
$('#clearBtn').addEventListener('click', () => {
  if (busy) { for (const it of items) if (it.status === 'queued') it.status = 'stopped'; stopWorker(); }
  items.splice(0).forEach(it => it.el.remove());
  $('#resultBox').hidden = true;
  updateSummary();
});

// ---------- ファイルの受け取り ----------
const input = $('#fileInput');
$('#pickBtn').addEventListener('click', e => { e.stopPropagation(); input.click(); });
$('#drop').addEventListener('click', () => input.click());
$('#drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

// ページのどこに落としても受け付ける
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').classList.add('over'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').classList.remove('over'); });
window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0; $('#drop').classList.remove('over');
  if ($('[data-panel="main"]').hidden) document.querySelector('nav.tabs button[data-tab="main"]').click();
  addFiles(e.dataTransfer.files);
});

// アプリとして追加した場合（Chrome・Edge）：エクスプローラーの「プログラムから開く」で渡された PDF を受け取る
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    addFiles(await Promise.all(params.files.map(h => h.getFile())));
  });
}

// ---------- 画質の確認 ----------
const dlg = $('#compare');
let cmp = null;   // { it, page, seq }

function openCompare(it) {
  cmp = { it, page: 1, seq: 0 };
  $('#cmpTitle').textContent = it.file.name;
  $('#cmpTitle').title = it.file.name;
  $('#cmpPage').max = String(it.pages || 1);
  $('#cmpPages').textContent = it.pages ? `/ ${it.pages}` : '';
  $('#cmpSizeA').textContent = formatBytes(it.file.size);
  $('#cmpSizeB').textContent = formatBytes(it.result.size);
  dlg.showModal();
  renderCompare();
}

async function renderCompare() {
  if (!cmp) return;
  const { it } = cmp;
  const max = it.pages || 1;
  cmp.page = Math.min(Math.max(1, cmp.page), max);
  $('#cmpPage').value = String(cmp.page);
  $('#cmpPrev').disabled = cmp.page <= 1;
  $('#cmpNext').disabled = cmp.page >= max;
  const seq = ++cmp.seq;
  const dpi = Number($('#cmpZoom').value);
  const views = [$('#cmpA'), $('#cmpB')];
  for (const v of views) { v.querySelectorAll('.wait').forEach(x => x.remove()); const w = document.createElement('div'); w.className = 'wait'; w.textContent = '表示を作っています…'; v.append(w); }
  const sources = [it.file, it.result];
  for (let k = 0; k < 2; k++) {
    const data = new Uint8Array(await sources[k].arrayBuffer());
    // 圧縮前のファイルだけパスワードが要る（圧縮後はかかっていない）
    const r = await runGs(renderArgs('in.pdf', 'page.png', cmp.page, dpi, k === 0 ? it.password : undefined), { 'in.pdf': data }, ['page.png']);
    if (!cmp || seq !== cmp.seq) return;   // 途中でページや倍率が変わった
    const v = views[k];
    v.querySelectorAll('.wait').forEach(x => x.remove());
    if (!r.ok) { const w = document.createElement('div'); w.className = 'wait'; w.textContent = `表示できませんでした：${r.message}`; v.append(w); continue; }
    const url = URL.createObjectURL(new Blob([r.files['page.png']], { type: 'image/png' }));
    let img = v.querySelector('img');
    const keep = img ? { x: v.scrollLeft, y: v.scrollTop } : null;
    if (!img) { img = document.createElement('img'); img.alt = k ? '圧縮後' : '圧縮前'; v.append(img); }
    const old = img.src;
    img.onload = () => {
      // 「等倍」は 96 dpi（CSS の 1px = 1/96 インチ）で描くので、画像の画素数のまま表示すれば実寸になる
      if (keep) { v.scrollLeft = keep.x; v.scrollTop = keep.y; }
      else if (cmp?.frac) { v.scrollLeft = cmp.frac.x * v.scrollWidth; v.scrollTop = cmp.frac.y * v.scrollHeight; }
      if (old) URL.revokeObjectURL(old);
    };
    img.src = url;
  }
}

// 2 つの表示を一緒にスクロールする
let syncing = false;
for (const [a, b] of [[$('#cmpA'), $('#cmpB')], [$('#cmpB'), $('#cmpA')]]) {
  a.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    b.scrollLeft = a.scrollLeft; b.scrollTop = a.scrollTop;
    requestAnimationFrame(() => { syncing = false; });
  });
}
$('#cmpPrev').addEventListener('click', () => { cmp.page--; renderCompare(); });
$('#cmpNext').addEventListener('click', () => { cmp.page++; renderCompare(); });
$('#cmpPage').addEventListener('change', e => { cmp.page = Number(e.target.value) || 1; renderCompare(); });
$('#cmpZoom').addEventListener('change', () => {
  // 倍率を変えたら、同じ場所が見えるようにスクロール位置を割合で引き継ぐ
  const a = $('#cmpA');
  cmp.frac = a.scrollWidth ? { x: a.scrollLeft / a.scrollWidth, y: a.scrollTop / a.scrollHeight } : null;
  for (const v of [$('#cmpA'), $('#cmpB')]) { const img = v.querySelector('img'); if (img) { URL.revokeObjectURL(img.src); img.remove(); } }
  renderCompare();
});
$('#cmpClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => {
  for (const v of [$('#cmpA'), $('#cmpB')]) { const img = v.querySelector('img'); if (img) { URL.revokeObjectURL(img.src); img.remove(); } }
  cmp = null;
});

// ---------- オフライン用の Service Worker ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 登録できなくても動作には影響しない */ });
}
