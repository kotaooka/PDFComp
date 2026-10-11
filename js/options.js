// 圧縮設定 → Ghostscript の引数、および PDF の事前チェック
// 画面に依存しないので Node のテストからも読み込める

// 品質プリセット（Ghostscript の -dPDFSETTINGS）。dpi は画像を縮小するときの解像度
export const PRESETS = {
  screen:   { label: '最小サイズ', dpi: 72,  desc: '画像を 72 dpi に縮小します。画面で見るだけの資料向け。写真・細かい図は粗くなります' },
  ebook:    { label: '標準',       dpi: 150, desc: '画像を 150 dpi に縮小します。画面表示とふつうの印刷に十分な画質です' },
  printer:  { label: '印刷向け',   dpi: 300, desc: '画像を 300 dpi に縮小します。印刷に使う資料向け。縮む量は小さめです' },
  prepress: { label: '高画質',     dpi: 300, desc: '300 dpi で、色の情報（カラープロファイル）も残します。縮む量は最も小さくなります' },
};

export const DEFAULT_SETTINGS = { preset: 'ebook', dpi: 0, gray: false, keepSmaller: true };

// 白黒 2 値の画像（スキャンした文字など）の解像度。カラー・グレーの 2 倍とし、300〜1200 dpi に収める
export function monoDpi(dpi) {
  return Math.min(Math.max(dpi * 2, 300), 1200);
}

// 圧縮用の引数
export function compressArgs(settings, input, output, password) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const preset = PRESETS[s.preset] ? s.preset : 'ebook';
  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    `-dPDFSETTINGS=/${preset}`,
    '-dNOPAUSE', '-dBATCH', '-dSAFER',
  ];
  if (s.dpi > 0) {
    const d = Math.round(s.dpi);
    args.push(
      '-dDownsampleColorImages=true', `-dColorImageResolution=${d}`,
      '-dDownsampleGrayImages=true', `-dGrayImageResolution=${d}`,
      '-dDownsampleMonoImages=true', `-dMonoImageResolution=${monoDpi(d)}`,
    );
  }
  if (s.gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  if (password) args.push(`-sPDFPassword=${password}`);
  args.push(`-sOutputFile=${output}`, input);
  return args;
}

// 画質確認用：指定ページを PNG にする引数
//   -dMaxBitmap：ページを帯に分けて描く方式（clist）を使わせないため。この WASM 版は clist で画像を拡大すると
//   メモリ範囲外アクセスで停止する（圧縮後の 150 dpi の画像を 192 dpi で描くと再現。tests/test.mjs で確認）
export function renderArgs(input, output, page, dpi, password) {
  const args = [
    '-sDEVICE=png16m', `-r${dpi}`, '-dMaxBitmap=1000000000',
    `-dFirstPage=${page}`, `-dLastPage=${page}`,
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
    '-dNOPAUSE', '-dBATCH', '-dSAFER',
  ];
  if (password) args.push(`-sPDFPassword=${password}`);
  args.push(`-sOutputFile=${output}`, input);
  return args;
}

// 出力ファイル名（元の名前_compressed.pdf）
export function outputName(name) {
  const base = name.replace(/\.pdf$/i, '');
  return `${base}_compressed.pdf`;
}

// PDF の中身を文字列として探して、注意が必要な要素を調べる（目安）
//   暗号化の辞書（/Encrypt）はトレーラーにあり圧縮されないので確実に見つかる。
//   電子署名の /ByteRange も署名の辞書は圧縮されないのが通例。
//   入力欄（/AcroForm）はオブジェクトストリーム内に圧縮されていると見つからないことがある
export function inspect(bytes) {
  const res = { pdf: false, encrypted: false, signed: false, form: false };
  const head = latin1(bytes.subarray(0, 1024));
  res.pdf = head.includes('%PDF-');
  const step = 4 * 1024 * 1024, overlap = 64;
  for (let i = 0; i < bytes.length; i += step) {
    const s = latin1(bytes.subarray(i, Math.min(bytes.length, i + step + overlap)));
    if (!res.encrypted && /\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(s)) res.encrypted = true;
    if (!res.signed && /\/ByteRange\s*\[/.test(s)) res.signed = true;
    if (!res.form && /\/AcroForm\b/.test(s)) res.form = true;
  }
  return res;
}

function latin1(u8) {
  let s = '';
  const n = 0x8000;
  for (let i = 0; i < u8.length; i += n) s += String.fromCharCode.apply(null, u8.subarray(i, i + n));
  return s;
}

// 表示用のサイズ（1,024 進）。有効数字 3 桁
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}
