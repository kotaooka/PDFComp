// ローカル版（1 ファイルの HTML）を作る
//   node tools/build-local.mjs   →  local/PDFComp.html
// index.html・js/・圧縮エンジン（gs.wasm を gzip して base64 にしたもの）を 1 つの HTML にまとめる。
// ダブルクリックで開く（file://）と ES モジュールの読み込みとワーカーの起動ができないため、
// スクリプトはすべて HTML に埋め込み、ワーカーは blob URL から起動する。
// Chrome は file:// のページからモジュール形式のワーカーを起動できないため、ワーカーはクラシック形式にする
// （import / export を外し、import.meta.url を self.location.href に置き換える）。
// 外部への接続（Google Fonts）はなくし、字体は Windows 標準の BIZ UDPゴシックを使う。
// 出力は入力が同じなら毎回同じバイト列になる（CI で最新かどうかを確かめるため）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const OUT = join(ROOT, 'local', 'PDFComp.html');

// 置き換え対象が見つからなければ止める（元のファイルが変わってビルドが黙って壊れるのを防ぐ）
function replaceOnce(text, from, to, what) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${what}：置き換え対象が ${n} 箇所あります（1 箇所のはず）\n${from}`);
  return text.replace(from, () => to);
}

// ES モジュールの import 行を消し、export を外す（1 つのスクリプトにまとめるため）
function stripModule(src, what) {
  const out = src
    .replace(/^import .* from '.*';\r?\n/gm, '')
    .replace(/^export (const|function|async function) /gm, '$1 ');
  if (/^\s*(import|export)\b/m.test(out)) throw new Error(`${what}：消せない import / export があります`);
  return out;
}

function checkScript(js, what) {
  if (/<\/script/i.test(js)) throw new Error(`${what}：</script を含むため埋め込めません`);
  return js;
}

// ---------- ワーカー（Ghostscript + worker.js） ----------
const gsJs = replaceOnce(read('vendor/ghostpdl-wasm/gs.js'), 'export default Module;', 'const loadGhostscript = Module;', 'gs.js');
const workerJs = stripModule(read('js/worker.js'), 'worker.js');
const workerSrc = checkScript(`${gsJs}\n${workerJs}`.replaceAll('import.meta.url', 'self.location.href'), 'ワーカー');
if (/\bimport\.meta\b/.test(workerSrc)) throw new Error('ワーカー：import.meta が残っています');

// ---------- 画面（options.js + zip.js + app.js） ----------
const appSrc = checkScript([
  stripModule(read('js/options.js'), 'options.js'),
  stripModule(read('js/zip.js'), 'zip.js'),
  stripModule(read('js/app.js'), 'app.js'),
].join('\n'), '画面');

// ---------- 圧縮エンジン ----------
const wasm = readFileSync(join(ROOT, 'vendor/ghostpdl-wasm/gs.wasm'));
const wasmGz = gzipSync(wasm, { level: constants.Z_BEST_COMPRESSION });
const appWasmSize = /const WASM_SIZE = (\d+);/.exec(read('js/app.js'))?.[1];
if (Number(appWasmSize) !== wasm.length) throw new Error(`js/app.js の WASM_SIZE（${appWasmSize}）が gs.wasm の大きさ（${wasm.length}）と違います`);

// ワーカーの起動：埋め込んだ文字列から作ったクラシック形式のワーカーに、gzip した wasm を Blob で渡す
// （file:// のページでは、ワーカーから blob URL を fetch できないため）。Blob は最初の 1 回だけ作り、作り直すときは使い回す
const loader = `
// ローカル版：埋め込んだワーカーを起動し、圧縮エンジンを渡す
(() => {
  let url = null, gz = null;
  window.PDFCOMP_LOCAL_WORKER = () => {
    if (!url) {
      const bin = atob(document.getElementById('gs-wasm-gz').textContent.trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      gz = new Blob([bytes], { type: 'application/gzip' });
      url = URL.createObjectURL(new Blob([document.getElementById('gs-worker').textContent], { type: 'text/javascript' }));
    }
    const w = new Worker(url);
    w.postMessage({ type: 'localWasm', gz });
    return w;
  };
})();`;

// ---------- HTML ----------
let html = read('index.html');
const dataUri = p => `data:image/png;base64,${readFileSync(join(ROOT, p)).toString('base64')}`;

html = replaceOnce(html, '<title>PDF圧縮｜', '<title>PDF圧縮（ローカル版）｜', 'title');
html = replaceOnce(html, '<link rel="manifest" href="manifest.webmanifest">\n', '', 'manifest');
html = replaceOnce(html, 'href="icons/icon-192.png"', `href="${dataUri('icons/icon-192.png')}"`, 'icon');
html = replaceOnce(html, '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n', '', 'apple-touch-icon');
html = replaceOnce(html,
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&family=IBM+Plex+Mono:wght@500&display=swap">\n',
  '', 'Google Fonts');
html = replaceOnce(html,
  '<p>このページはGitHub Pagesから配信している静的なページです。PDFはブラウザの中のGhostscript（WebAssembly版）で処理し、この端末の外には送りません。一度開けば、オフラインでも動きます。</p>',
  '<p>これはローカル版です。圧縮エンジンを含むすべてをこの1つのHTMLファイルに収めているため、インストールは不要で、インターネットにつながっていなくても動きます。PDFはブラウザの中のGhostscript（WebAssembly版）で処理し、この端末の外には送りません。字体の読み込みも含め、外部のサーバーには接続しません（下のリンクを開いたときを除く）。</p>',
  'データの扱い');
html = replaceOnce(html,
  '<span id="engineText">初回だけ、圧縮エンジン（約15 MB）を読み込みます。2回目からは保存したものを使います。</span>',
  '<span id="engineText">圧縮エンジンはこのファイルに含まれています（インターネット接続は不要です）。</span>',
  'エンジンの説明');
html = replaceOnce(html, '<script type="module" src="js/app.js"></script>',
  `<script type="application/octet-stream" id="gs-wasm-gz">\n${wasmGz.toString('base64')}\n</script>\n` +
  `<script type="text/plain" id="gs-worker">\n${workerSrc}\n</script>\n` +
  `<script>${loader}\n</script>\n` +
  `<script type="module">\n${appSrc}\n</script>`,
  'app.js');
if (/(src|href)="(?!https?:|data:|#)/.test(html)) throw new Error('相対パスの参照が残っています');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`${OUT}  ${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB（gs.wasm ${(wasm.length / 1048576).toFixed(1)} MB → gzip ${(wasmGz.length / 1048576).toFixed(1)} MB）`);
