// テスト：node tests/test.mjs（Node 20 以降）。失敗があれば終了コード 1
// 同梱の Ghostscript（vendor/ghostpdl-wasm）を Node で動かし、圧縮・描画・補助関数を確かめる。
// テスト用の PDF はここで組み立てる（外部のファイルやライブラリを使わない）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import loadGhostscript from '../vendor/ghostpdl-wasm/gs.js';
import { compressArgs, renderArgs, outputName, inspect, monoDpi, formatBytes, PRESETS } from '../js/options.js';
import { crc32, makeZip } from '../js/zip.js';

// WASM が停止して戻らない場合に備えた全体の制限時間
setTimeout(() => { console.log('  NG  制限時間（3 分）を超えました'); process.exit(1); }, 180000);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  NG  ${name} ${detail}`); }
}

// ---------- テスト用 PDF ----------
// 1 ページに 1,200 × 1,600 画素のカラー画像（乱数を混ぜたグラデーション、Flate 圧縮）を A4 全面に置く。
// 画像は約 400 dpi 相当なので、標準（150 dpi）で縮小・JPEG 化されて大きく縮むはず
function makePdf({ pages = 1, extra = '' } = {}) {
  const W = 1200, H = 1600;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, n = (rnd() - 0.5) * 60;
    raw[i] = Math.max(0, Math.min(255, x / W * 255 + n));
    raw[i + 1] = Math.max(0, Math.min(255, y / H * 255 + n));
    raw[i + 2] = Math.max(0, Math.min(255, 128 + n));
  }
  const img = zlib.deflateSync(raw);
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`), img, Buffer.from('\nendstream')]);
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let p = 0; p < pages; p++) {
    const content = `q 595 0 0 842 0 0 cm /Im0 Do Q BT /F1 24 Tf 50 50 Td (Page ${p + 1}) Tj ET`;
    const c = 5 + p * 2, pg = 6 + p * 2;
    objs[c] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    objs[pg] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 3 0 R >> /Font << /F1 4 0 R >> >> /Contents ${c} 0 R ${extra} >>`;
    kids.push(`${pg} 0 R`);
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    const body = Buffer.isBuffer(objs[i]) ? objs[i] : Buffer.from(objs[i], 'latin1');
    const b = Buffer.concat([Buffer.from(`${i} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets[i] = pos; parts.push(b); pos += b.length;
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

// ---------- Ghostscript の実行（js/worker.js と同じ呼び出し方） ----------
const wasm = await WebAssembly.compile(fs.readFileSync(path.join(ROOT, 'vendor/ghostpdl-wasm/gs.wasm')));
async function gs(args, input, output) {
  const log = [];
  const M = await loadGhostscript({
    print: s => log.push(s), printErr: s => log.push('E: ' + s),
    instantiateWasm(imports, done) { WebAssembly.instantiate(wasm, imports).then(i => done(i, wasm)); return {}; },
  });
  M.FS.writeFile('in.pdf', input);
  let rc;
  try { rc = M.callMain(args); } catch (e) { return { rc: 'trap', error: String(e), log }; }
  let out = null;
  try { out = M.FS.readFile(output); } catch (e) { /* 出力なし */ }
  return { rc, out, log };
}

console.log('圧縮');
const src = makePdf({ pages: 2 });
const t0 = Date.now();
const c = await gs(compressArgs({ preset: 'ebook' }, 'in.pdf', 'out.pdf'), src, 'out.pdf');
check('終了コード 0', c.rc === 0, `rc=${c.rc}`);
check('出力が PDF', c.out && Buffer.from(c.out.subarray(0, 5)).toString() === '%PDF-');
check('元の 1/5 以下に縮む', c.out && c.out.length < src.length / 5, `${src.length} → ${c.out?.length}`);
check('総ページ数の行が出る（進捗表示に使う）', c.log.includes('Processing pages 1 through 2.'));
check('ページごとの行が出る', c.log.includes('Page 1') && c.log.includes('Page 2'));
console.log(`  （${formatBytes(src.length)} → ${formatBytes(c.out?.length ?? 0)}、${Date.now() - t0} ms）`);

console.log('プリセットと詳細設定');
const sizes = {};
for (const p of Object.keys(PRESETS)) {
  const r = await gs(compressArgs({ preset: p }, 'in.pdf', 'out.pdf'), src, 'out.pdf');
  sizes[p] = r.out?.length ?? Infinity;
}
check('最小サイズ < 印刷向け', sizes.screen < sizes.printer, JSON.stringify(sizes));
check('標準 < 印刷向け', sizes.ebook < sizes.printer, JSON.stringify(sizes));
const d72 = await gs(compressArgs({ preset: 'printer', dpi: 72 }, 'in.pdf', 'out.pdf'), src, 'out.pdf');
check('解像度の指定がプリセットより優先される', d72.out && d72.out.length < sizes.printer / 3, `${d72.out?.length} vs ${sizes.printer}`);
const gray = await gs(compressArgs({ preset: 'ebook', gray: true }, 'in.pdf', 'out.pdf'), src, 'out.pdf');
check('白黒にすると色空間が DeviceGray になる', gray.out && /\/DeviceGray/.test(Buffer.from(gray.out).toString('latin1')) && !/\/DeviceRGB/.test(Buffer.from(gray.out).toString('latin1')));

console.log('画質確認用の描画');
// 圧縮後（150 dpi の画像）を 288 dpi で描く＝画像を拡大する。-dMaxBitmap がないとこの WASM 版は停止する
const r = await gs(renderArgs('in.pdf', 'page.png', 2, 288), c.out, 'page.png');
check('圧縮後のページを拡大して描ける', r.rc === 0 && r.out && r.out.length > 1000, `rc=${r.rc} ${r.error ?? ''}`);
check('PNG が出る', r.out && Buffer.from(r.out.subarray(1, 4)).toString() === 'PNG');
check('2 ページ目を指定できる', r.out && Buffer.from(r.out).readUInt32BE(16) === Math.round(595 / 72 * 288));

console.log('壊れたファイル');
const bad = await gs(compressArgs({}, 'in.pdf', 'out.pdf'), new TextEncoder().encode('%PDF-1.4\nこれは PDF ではない'), 'out.pdf');
check('エラーとして検出できる', bad.rc !== 0 || /Error|error/.test(bad.log.join('\n')));

console.log('事前チェック（inspect）');
const enc = new TextEncoder();
check('ふつうの PDF', JSON.stringify(inspect(src)) === JSON.stringify({ pdf: true, encrypted: false, signed: false, form: false }));
check('PDF でないもの', inspect(enc.encode('hello')).pdf === false);
check('暗号化（参照）', inspect(enc.encode('%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>')).encrypted);
check('暗号化（直接）', inspect(enc.encode('%PDF-1.7\ntrailer << /Encrypt << /Filter /Standard >> >>')).encrypted);
check('電子署名', inspect(enc.encode('%PDF-1.7\n<< /Type /Sig /ByteRange [0 100 200 300] >>')).signed);
check('入力欄', inspect(enc.encode('%PDF-1.7\n<< /Type /Catalog /AcroForm 5 0 R >>')).form);

console.log('補助関数');
check('出力名', outputName('検査成績書.PDF') === '検査成績書_compressed.pdf' && outputName('a.b.pdf') === 'a.b_compressed.pdf');
check('白黒 2 値の解像度', monoDpi(72) === 300 && monoDpi(200) === 400 && monoDpi(1000) === 1200);
check('パスワードは引数に入る', compressArgs({}, 'i', 'o', 'p w').includes('-sPDFPassword=p w'));
check('サイズ表示', formatBytes(512) === '512 B' && formatBytes(1536) === '1.50 KB' && formatBytes(15533045) === '14.8 MB');

console.log('ZIP');
check('CRC-32 の既知値', crc32(enc.encode('123456789')) === 0xcbf43926);
const zip = new Uint8Array(await makeZip([{ name: '検査_compressed.pdf', data: enc.encode('abc') }, { name: 'b.pdf', data: new Uint8Array(0) }], new Date(2026, 9, 11, 12, 34, 56)).arrayBuffer());
const dv = new DataView(zip.buffer);
const eocd = zip.length - 22;
check('終端レコード', dv.getUint32(eocd, true) === 0x06054b50 && dv.getUint16(eocd + 10, true) === 2);
const cdOff = dv.getUint32(eocd + 16, true);
check('中央ディレクトリの位置', dv.getUint32(cdOff, true) === 0x02014b50);
check('UTF-8 フラグ', dv.getUint16(6, true) === 0x0800 && dv.getUint16(cdOff + 8, true) === 0x0800);
const nameLen = dv.getUint16(26, true);
check('ファイル名が UTF-8', new TextDecoder().decode(zip.subarray(30, 30 + nameLen)) === '検査_compressed.pdf');
check('中身がそのまま入る', new TextDecoder().decode(zip.subarray(30 + nameLen, 33 + nameLen)) === 'abc' && dv.getUint32(14, true) === crc32(enc.encode('abc')));

console.log(`\n${passed} 件成功、${failed} 件失敗`);
process.exit(failed ? 1 : 0);
