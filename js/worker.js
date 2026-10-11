// Ghostscript（WebAssembly 版）を動かすワーカー
// 画面側（app.js）から受け取ったファイルと引数で Ghostscript を 1 回実行し、出力ファイルを返す。
// wasm のコンパイルは最初の 1 回だけ行い、実行ごとに新しいインスタンスを作る
// （Ghostscript は 1 回の実行で終了する作りのため、使い回さずに毎回作り直すほうが確実で、メモリも解放される）
import loadGhostscript from '../vendor/ghostpdl-wasm/gs.js';

const WASM_URL = new URL('../vendor/ghostpdl-wasm/gs.wasm', import.meta.url);
let wasmModule = null;

// wasm を取得してコンパイルする。進捗（受信バイト数）を画面に送る
async function prepare(expectedSize) {
  if (wasmModule) return;
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error(`エンジン（gs.wasm）を取得できません（HTTP ${res.status}）`);
  // 圧縮転送のとき Content-Length は圧縮後の大きさになるので、展開後の大きさ（既知の値）を分母に使う
  const total = expectedSize || Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 100) { postMessage({ type: 'load', loaded, total }); lastPost = now; }
  }
  postMessage({ type: 'load', loaded, total: Math.max(total, loaded) });
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  wasmModule = await WebAssembly.compile(bytes);
}

// Ghostscript を 1 回実行する
//   inputs: { 仮想ファイル名: Uint8Array }、outputs: 読み出す出力ファイル名の配列
async function runGs(id, args, inputs, outputs) {
  const log = [];
  let pages = 0;
  const onLine = (s, isErr) => {
    log.push(isErr ? 'E: ' + s : s);
    // 「Processing pages 1 through N.」で総ページ数、「Page n」で進み具合が分かる
    let m = /^Processing pages (\d+) through (\d+)\./.exec(s);
    if (m) { pages = Number(m[2]) - Number(m[1]) + 1; postMessage({ type: 'progress', id, page: 0, pages }); return; }
    m = /^Page (\d+)$/.exec(s);
    if (m) postMessage({ type: 'progress', id, page: Number(m[1]), pages });
  };
  const gs = await loadGhostscript({
    print: s => onLine(s, false),
    printErr: s => onLine(s, true),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasmModule, imports).then(inst => done(inst, wasmModule));
      return {};
    },
  });
  for (const [name, data] of Object.entries(inputs)) gs.FS.writeFile(name, data);
  let rc;
  try {
    rc = gs.callMain(args);
  } catch (e) {
    // メモリ不足などで wasm が異常終了した場合
    const msg = String(e && e.message || e);
    return { ok: false, code: /memory|Cannot enlarge|out of bounds|RangeError/i.test(msg) ? 'memory' : 'crash', message: msg, log };
  }
  const text = log.join('\n');
  if (/Password did not work/i.test(text)) return { ok: false, code: 'badpassword', message: 'パスワードが違います', log };
  if (/requires a password/i.test(text)) return { ok: false, code: 'password', message: 'パスワードが必要です', log };
  if (rc !== 0 || /Couldn't initialise file|Unrecoverable error/i.test(text)) {
    return { ok: false, code: 'failed', message: `Ghostscript がエラーを返しました（終了コード ${rc}）`, log };
  }
  const files = {};
  for (const name of outputs) {
    try { files[name] = gs.FS.readFile(name); } catch (e) { /* 出力されなかった */ }
  }
  if (!Object.keys(files).length) return { ok: false, code: 'failed', message: '出力ファイルが作られませんでした', log };
  return { ok: true, files, pages, log };
}

self.onmessage = async ev => {
  const msg = ev.data;
  try {
    if (msg.type === 'prepare') {
      await prepare(msg.expectedSize);
      postMessage({ type: 'ready' });
    } else if (msg.type === 'run') {
      await prepare(msg.expectedSize);
      const r = await runGs(msg.id, msg.args, msg.inputs, msg.outputs);
      const transfer = r.ok ? Object.values(r.files).map(f => f.buffer) : [];
      postMessage({ type: 'result', id: msg.id, ...r }, transfer);
    }
  } catch (e) {
    postMessage({ type: msg.type === 'prepare' ? 'loadError' : 'result', id: msg.id, ok: false, code: 'crash', message: String(e && e.message || e), log: [] });
  }
};
