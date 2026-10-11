// 圧縮設定 → Ghostscript の引数、および PDF の事前チェック
// 画面に依存しないので Node のテストからも読み込める

// 品質プリセット（Ghostscript の -dPDFSETTINGS）。dpi は画像を縮小するときの解像度
export const PRESETS = {
  screen:   { label: '最小サイズ', dpi: 72,  desc: '画像を 72 dpi に縮小します。画面で見るだけの資料向け。写真・細かい図は粗くなります' },
  ebook:    { label: '標準',       dpi: 150, desc: '画像を 150 dpi に縮小します。画面表示とふつうの印刷に十分な画質です' },
  printer:  { label: '印刷向け',   dpi: 300, desc: '画像を 300 dpi に縮小します。印刷に使う資料向け。縮む量は小さめです' },
  prepress: { label: '高画質',     dpi: 300, desc: '300 dpi で、色の情報（カラープロファイル）も残します。縮む量は最も小さくなります' },
};

// mode: preset（強さを選ぶ）| target（目標サイズを指定）。target はバイト数（1 MB = 1,048,576 バイト）
export const DEFAULT_SETTINGS = { mode: 'preset', preset: 'ebook', dpi: 0, gray: false, keepSmaller: true, target: 2 * 1048576 };

// 白黒 2 値の画像（スキャンした文字など）の解像度。カラー・グレーの 2 倍とし、300〜1200 dpi に収める
export function monoDpi(dpi) {
  return Math.min(Math.max(dpi * 2, 300), 1200);
}

// 画像の縮小を指定する引数
//   しきい値 1.0：目標の解像度より細かい画像はすべて縮小する。Ghostscript の既定は 1.5 で、
//   たとえば 300 dpi の画像を 200 dpi 指定にしても 1.5 倍を超えないため縮小されない
function downsampleArgs(dpi) {
  const d = Math.round(dpi);
  return [
    '-dDownsampleColorImages=true', `-dColorImageResolution=${d}`, '-dColorImageDownsampleThreshold=1.0',
    '-dDownsampleGrayImages=true', `-dGrayImageResolution=${d}`, '-dGrayImageDownsampleThreshold=1.0',
    '-dDownsampleMonoImages=true', `-dMonoImageResolution=${monoDpi(d)}`, '-dMonoImageDownsampleThreshold=1.0',
  ];
}

// 圧縮用の引数
//   level を渡すと目標サイズ用（TARGET_LEVELS の 1 段）：標準（/ebook）を土台に解像度と JPEG の画質を指定する
export function compressArgs(settings, input, output, password, level) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const preset = level ? 'ebook' : (PRESETS[s.preset] ? s.preset : 'ebook');
  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    `-dPDFSETTINGS=/${preset}`,
    '-dNOPAUSE', '-dBATCH', '-dSAFER',
  ];
  if (level) args.push(...downsampleArgs(level.dpi));
  else if (s.dpi > 0) args.push(...downsampleArgs(s.dpi));
  if (s.gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  if (password) args.push(`-sPDFPassword=${password}`);
  args.push(`-sOutputFile=${output}`);
  if (level) {
    // JPEG の画質（QFactor：小さいほど高画質）。写真か線画かは Ghostscript が画像ごとに判定し（AutoFilter）、
    // JPEG を選んだ画像にこの画質を使う（ACS = 自動判定時の設定）
    const dict = `<< /QFactor ${level.q} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
    args.push('-c', `<< /ColorACSImageDict ${dict} /GrayACSImageDict ${dict} /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams`, '-f');
  }
  args.push(input);
  return args;
}

// 目標サイズ用の段階（高画質 → 低画質）。上から順に、目標に収まる最も高画質な段を二分探索で探す
export const TARGET_LEVELS = [
  { dpi: 300, q: 0.4 }, { dpi: 250, q: 0.5 }, { dpi: 200, q: 0.6 }, { dpi: 175, q: 0.7 },
  { dpi: 150, q: 0.76 }, { dpi: 125, q: 0.9 }, { dpi: 100, q: 1.0 }, { dpi: 85, q: 1.2 },
  { dpi: 72, q: 1.4 }, { dpi: 60, q: 1.8 }, { dpi: 50, q: 2.4 },
];

// JPEG 画質の表示名
export function qualityLabel(q) {
  return q <= 0.5 ? '高' : q <= 0.8 ? '標準' : q <= 1.3 ? '低' : '最低';
}

// 目標サイズに収まる最も高画質な段を探す
//   evaluate(index) は TARGET_LEVELS[index] で圧縮し、{ size, ...任意 } を返す（失敗時は例外を投げる）
//   画質を下げるほど小さくなる前提で二分探索する（実行は最大 5 回）。前提が崩れても、
//   試した中で目標以下の最も高画質なもの（なければ最も小さいもの）を返す
export async function searchTarget(target, evaluate, levels = TARGET_LEVELS) {
  const tried = new Map();
  const run = async i => {
    if (!tried.has(i)) tried.set(i, await evaluate(i));
    return tried.get(i);
  };
  let lo = -1, hi = levels.length;       // lo：収まらない段、hi：収まる段（levels.length は「なし」）
  // 1 回目は最高画質。収まればそれで終わり
  if ((await run(0)).size <= target) hi = 0;
  else {
    lo = 0;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await run(mid)).size <= target) hi = mid; else lo = mid;
    }
  }
  const fits = [...tried].filter(([, r]) => r.size <= target).sort((a, b) => a[0] - b[0]);
  if (fits.length) { const [index, result] = fits[0]; return { reached: true, index, result, attempts: tried.size }; }
  const [index, result] = [...tried].sort((a, b) => a[1].size - b[1].size)[0];
  return { reached: false, index, result, attempts: tried.size };
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
