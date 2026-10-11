@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: ================================================
:: PDFComp - PDF圧縮ツール
:: Ghostscriptを使ってPDFファイルを圧縮する
:: ================================================

echo ================================================
echo   PDFComp - PDF圧縮ツール
echo ================================================
echo;

:: --- Ghostscriptの存在確認 ---
where /q gswin64c
if errorlevel 1 (
    echo [エラー] Ghostscriptが導入されていません。
    echo         ダウンロードページを開きます...
    start https://www.ghostscript.com/download/gsdnld.html
    pause
    exit /b 1
)

:: --- 圧縮品質の選択 ---
echo 圧縮品質を選んでください:
echo;
echo   [1] screen  - 最高圧縮 ^(72 dpi、ファイルサイズ最小、画質低め^)
echo   [2] ebook   - 標準圧縮 ^(150 dpi、バランス重視^)  <- デフォルト
echo   [3] printer - 低圧縮   ^(300 dpi、印刷向け、画質高め^)
echo   [4] prepress- 最低圧縮 ^(300 dpi+、印刷業者向け、画質最高^)
echo;
set /p "QUALITY_INPUT=番号を入力してEnter (空Enterで2を選択): "

if "!QUALITY_INPUT!"=="1" (
    set "QUALITY=screen"
    set "QUALITY_NAME=最高圧縮 (screen)"
) else if "!QUALITY_INPUT!"=="3" (
    set "QUALITY=printer"
    set "QUALITY_NAME=低圧縮 (printer)"
) else if "!QUALITY_INPUT!"=="4" (
    set "QUALITY=prepress"
    set "QUALITY_NAME=最低圧縮 (prepress)"
) else (
    set "QUALITY=ebook"
    set "QUALITY_NAME=標準圧縮 (ebook)"
)

echo;
echo 選択した品質: !QUALITY_NAME!
echo;

:: --- 処理件数カウンタの初期化 ---
set "SUCCESS_COUNT=0"
set "FAIL_COUNT=0"

:: --- ドラッグ&ドロップ or コマンドライン引数がある場合はそちらへ ---
:: ※ ラベルはifブロックの外に置く必要があるため goto で分岐
if not "%~1"=="" goto use_args

:: ==========================================
:: 通常起動: ファイル選択ダイアログ (複数選択可能)
:: ==========================================
echo ファイル選択ダイアログを開きます...
echo ^(Ctrlキーを押しながら選択すると複数ファイルを一括処理できます^)
echo;

:: 一時ファイルにファイルリストを書き出す
:: -Encoding Default (ANSI) でBOMなしにする (UTF8はBOM付きで文字化けするため)
set "TMPFILE=%TEMP%\pdfcomp_%RANDOM%.txt"

powershell -NoProfile -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $dlg = New-Object System.Windows.Forms.OpenFileDialog; $dlg.Filter = 'PDF Files (*.pdf)|*.pdf'; $dlg.Multiselect = $true; $dlg.Title = 'PDFファイルを選択 (複数選択可能)'; $dlg.ShowDialog() | Out-Null; $dlg.FileNames | Out-File -FilePath '%TMPFILE%' -Encoding Default"

:: 一時ファイルがなければキャンセルされたとみなす
if not exist "%TMPFILE%" (
    echo [情報] ファイルが選択されませんでした。
    pause
    exit /b 0
)

:: 一時ファイルを1行ずつ読み込んで処理
for /f "usebackq delims=" %%F in ("%TMPFILE%") do (
    if not "%%F"=="" call :process_file "%%F"
)

del "%TMPFILE%" 2>nul
goto show_summary

:: ==========================================
:: ドラッグ&ドロップ: 引数を順番に処理するループ
:: ※ ラベルはifブロックの外でないと機能しないため main フローに配置
:: ==========================================
:use_args
call :process_file "%~1"
shift
if not "%~1"=="" goto use_args

:: ==========================================
:: 処理結果のサマリー表示
:: ==========================================
:show_summary
echo;
echo ================================================
echo   処理完了
echo   成功: !SUCCESS_COUNT! 件 / 失敗: !FAIL_COUNT! 件
echo ================================================
echo;
pause
exit /b 0


:: ==========================================
:: サブルーチン: 1ファイルを圧縮処理する
:: 引数1: 入力ファイルパス
:: ==========================================
:process_file
    set "FILEPATH=%~1"

    :: ファイルの存在確認
    if not exist "!FILEPATH!" (
        echo [スキップ] ファイルが見つかりません: !FILEPATH!
        set /a FAIL_COUNT+=1
        exit /b 1
    )

    :: 拡張子チェック (PDFのみ受け付ける)
    if /i not "%~x1"==".pdf" (
        echo [スキップ] PDFファイルではありません: !FILEPATH!
        set /a FAIL_COUNT+=1
        exit /b 1
    )

    :: 元ファイルのディレクトリとファイル名を取得
    set "DIRPATH=%~dp1"
    set "BASENAME=%~n1"

    :: 出力パスを元ファイルと同じディレクトリに設定 (元のコードのバグを修正)
    set "OUTPUTPATH=!DIRPATH!compressed_!BASENAME!.pdf"
    set "SUFFIX=0"

    :: 同名出力ファイルが既に存在する場合は連番を付けて回避
    :: ※ call内でのgotoはcallのスタックを保持したまま動作するため正常に戻れる
    :check_exist
    if exist "!OUTPUTPATH!" (
        set /a SUFFIX+=1
        set "OUTPUTPATH=!DIRPATH!compressed_!BASENAME!_!SUFFIX!.pdf"
        goto check_exist
    )

    echo ----------------------------------------
    echo 処理中: !BASENAME!.pdf
    echo 出力先: !OUTPUTPATH!
    echo;

    :: Ghostscriptで圧縮実行 (引数は1行にまとめる。^改行は引数の途中で誤動作する場合があるため)
    gswin64c -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/!QUALITY! -dNOPAUSE -dBATCH -dQUIET -sOutputFile="!OUTPUTPATH!" "!FILEPATH!"

    if errorlevel 1 (
        echo [エラー] 圧縮に失敗しました: !BASENAME!.pdf
        set /a FAIL_COUNT+=1
        exit /b 1
    )

    if not exist "!OUTPUTPATH!" (
        echo [エラー] 出力ファイルが生成されませんでした: !BASENAME!.pdf
        set /a FAIL_COUNT+=1
        exit /b 1
    )

    :: 圧縮前後のサイズと削減率をPowerShellで計算・表示
    :: %%はバッチ内でのエスケープ。実行時に%に変換される
    powershell -NoProfile -Command "$src=(Get-Item '!FILEPATH!').Length; $dst=(Get-Item '!OUTPUTPATH!').Length; $ratio=[math]::Round((1-$dst/$src)*100,1); Write-Host ('  圧縮前: '+[math]::Round($src/1MB,2)+' MB'); Write-Host ('  圧縮後: '+[math]::Round($dst/1MB,2)+' MB'); if($ratio -gt 0){Write-Host ('  削減率: '+$ratio+'%% 削減') -ForegroundColor Green}else{Write-Host ('  ※ファイルが大きくなりました ('+[math]::Abs($ratio)+'%% 増加)。元のファイルの使用を推奨します。') -ForegroundColor Yellow}"

    echo;
    set /a SUCCESS_COUNT+=1
    exit /b 0
