# 開発者向け情報（pdfcomp）

利用者向けの説明は [README.md](README.md) にあります。

## ファイル構成

```
index.html                 画面（スタイルと「解説」タブの本文を含む）
js/app.js                  画面処理（一覧、保存、画質の確認）
js/worker.js               Ghostscript を動かすワーカー
js/options.js              設定 → Ghostscript の引数、PDF の事前チェック、表示用の関数。Node でも読み込み可
js/zip.js                  まとめて保存するための ZIP 作成（無圧縮、UTF-8 ファイル名）
vendor/ghostpdl-wasm/      Ghostscript の WebAssembly 版（npm の @okathira/ghostpdl-wasm 1.1.0 の dist と LICENSE）
sw.js                      オフライン用のキャッシュ処理（Service Worker）
manifest.webmanifest       アプリとして追加するための設定（PDF のファイルハンドラを含む）
icons/, og.png             アイコンと SNS 共有用画像（tools/make_images.py で作成）
docs/screenshots/          README 用のスクリーンショット（tools/screenshots.py で撮影）
tests/test.mjs             テスト（下記）
legacy/PDFComp.bat         以前のバッチ版（Ghostscript のインストールが必要）
.github/workflows/         push 時の自動テスト
```

ビルドは不要です。GitHub Pages は main ブランチのルートを公開しています。

## 更新して公開するとき

- `index.html`・`js/`・`vendor/`・`icons/` を変更したら、**`sw.js` 先頭の `VERSION` を必ず上げてから** push してください。上げないと、すでに使っている人の端末に古いファイルが残り続けます
- ローカルで確かめるときは、リポジトリのルートで `python -m http.server 8765` を起動して http://localhost:8765/ を開きます（`file://` ではワーカーが動きません）

## テスト

```
node tests/test.mjs     # Node 20 以降。失敗があれば終了コード 1
```

テスト用の PDF はテスト内で組み立てます。同梱の Ghostscript を Node で動かして、圧縮・プリセットの大小関係・解像度指定・白黒化・画質確認用の描画・壊れたファイル・事前チェック・ZIP の構造を確かめます。

## Ghostscript（WASM）の更新

1. `npm pack @okathira/ghostpdl-wasm@<版>` で取得し、`package/dist/gs.js`・`gs.wasm` と `package/LICENSE` を `vendor/ghostpdl-wasm/` に置き換える
2. `js/app.js` の `WASM_SIZE` を新しい `gs.wasm` のバイト数に合わせる（読み込みの進捗表示に使う）
3. `index.html` の「解説」と README の版を直す
4. `node tests/test.mjs` を通し、`sw.js` の `VERSION` を上げる

ビルドの由来は npm の Provenance（okathira/ghostpdl-wasm の GitHub Actions）で確かめられます。

## 実装のメモ

- **実行のしかた**：wasm のコンパイルは最初の 1 回だけ行い、Ghostscript を 1 回動かすたびに新しいインスタンスを作ります（`instantiateWasm` でコンパイル済みのモジュールを渡す）。Ghostscript は 1 回の実行で終了する作りなので、使い回すより確実で、実行後にメモリも解放されます
- **進捗**：`-dQUIET` を付けず、標準出力の `Processing pages 1 through N.` と `Page n` からページ単位の進み具合を出しています
- **エラーの判定**：パスワード付きの PDF は終了コード 0 のまま `This file requires a password` を出すので、出力の文言で判定します（誤ったパスワードは `Password did not work`）
- **画質確認の描画**：`png16m` で描きます。この WASM 版は、ページを帯に分けて描く方式（clist）で画像を拡大すると `memory access out of bounds` で停止するため、`-dMaxBitmap=1000000000` で帯分けを避けています（テストで再現と回避を確認）
- **圧縮設定**：`-dPDFSETTINGS` を基本にし、詳細設定の解像度はカラー・グレーに同じ値、白黒 2 値に 2 倍（300〜1,200 dpi）を指定します。白黒化は `-sColorConversionStrategy=Gray -dProcessColorModel=/DeviceGray`
- **確認済みの挙動**（Ghostscript 10.06.0）：しおり・リンク・文書情報は残る。AcroForm の入力欄は値ごと平坦化される。権限パスワードだけの PDF は制限なしで出力される。埋め込まれていない日本語フォントは代替フォントが埋め込まれ、見た目は保たれるが英数字のテキスト抽出が崩れることがある
- **事前チェック**（`inspect`）：PDF の中身を文字列として探す目安です。`/Encrypt`（トレーラー）と `/ByteRange`（電子署名）は圧縮されない場所にあるので確実性が高く、`/AcroForm` はオブジェクトストリーム内にあると見落とします
- **設定の保存**：ブラウザの localStorage（キー `pdfcomp-v1`）。表示テーマは QC Workbench 共通のキー `qc-workbench-theme`
