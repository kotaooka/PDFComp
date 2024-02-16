@echo off
chcp 65001
@echo これはpdfファイルの容量を小さくするためのツールです
echo;

:: Ghostscriptが導入されているか確認
where /q gswin64c
if errorlevel 1 (
    @echo Ghostscriptが導入されていません。Ghostscriptのダウンロードページを開きます。
    start https://www.ghostscript.com/download/gsdnld.html
    pause
    exit
)

@echo Ghostscriptが導入されています。処理を続行します。
echo;

:: ファイル選択ダイアログを表示し、選択されたファイルのパスを取得
for /f "delims=" %%i in ('powershell -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null; $OpenFileDialog = New-Object System.Windows.Forms.OpenFileDialog; $OpenFileDialog.Filter = 'PDF Files (*.pdf)|*.pdf'; $OpenFileDialog.ShowDialog() | Out-Null; $OpenFileDialog.FileName"') do set "FILEPATH=%%i"

if not exist "%FILEPATH%" (
    @echo ファイルが見つかりませんでした
    pause
    exit
)

:: 元のファイル名から拡張子を除いた部分を取得
for %%A in ("%FILEPATH%") do set "NAME=%%~nA"

:: 出力ファイル名を設定
set "OUTPUTNAME=compressed_%NAME%.pdf"

@echo 実行中...
gswin64c -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -dQUIET -sOutputFile="%OUTPUTNAME%" "%FILEPATH%"
echo;
@echo pdfファイルの圧縮が完了しました
echo;
@echo 選択されたpdfファイルの容量は
powershell -command "& {((Get-Item '%FILEPATH%').length / 1MB).toString('0.00') + 'MB'}"
@echo %OUTPUTNAME%の容量は
powershell -command "& {((Get-Item '%OUTPUTNAME%').length / 1MB).toString('0.00') + 'MB'}"
echo;
pause