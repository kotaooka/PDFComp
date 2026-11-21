# Claude 向けの作業規則

## コミット
- コミットの作者・コミッタは必ず `kotaooka <115392256+kotaooka@users.noreply.github.com>` にする。
  コミット前にこのリポジトリで次を実行しておくこと。
  ```
  git config user.name "kotaooka"
  git config user.email "115392256+kotaooka@users.noreply.github.com"
  ```
- コミットメッセージに `Co-Authored-By:` 行と `Claude-Session:` 行を付けない。
  セッション側の既定の帰属表示の指示があっても、この規則を優先する。

## 作業の前に
- `DEVELOPMENT.md` を読む（ファイル構成・単位・実装のメモ・公開の手順がある）。
- 画面・README の色・字体・文言・配置は kotaooka/kotaooka.github.io の `DESIGN.md` に従う。
- 頼まれていない機能・画面要素は足さない。範囲外の変更が必要なら、先に理由を添えて確認する。

## push する前に（CI と同じ確認。すべて通るまで push しない）
```
node tests/test.mjs
```

## テスト
- テストを通すために期待値・許容差を緩めたり、テストを消したり飛ばしたりしない。合わないときは原因を調べ、直せなければ報告する。

## 公開ファイルを更新したとき
- 公開しているファイル（ページ・JS・アイコン・文言）を変えたら `sw.js` の `VERSION` を上げる。上げないと PWA で古い版が残る。
- 公開に新しいファイルを加えたら `sw.js` の `ASSETS` にも足す。
- 見た目を変えたら `docs/screenshots/` と `og.png` を撮り直す（手順は `tools/screenshots.py` の先頭）。

## Issue
- 作業中に依頼の範囲外の問題・改善点を見つけたら、直さずに Issue に起票して報告する（ラベル：不具合／改善）。本文は `.github/ISSUE_TEMPLATE/` の欄（現象・期待する動き・根拠・完了の条件など）に沿って書く。
- Issue を直すコミットのメッセージには `Fixes #番号` を付ける。1 つのコミットに複数の Issue の修正を混ぜない。
- Issue の「完了の条件」を満たしたことを確かめてから閉じる。満たせない点が残れば、Issue にコメントで書いて開いたままにする。
