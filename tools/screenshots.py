# README 用のスクリーンショットを撮り直す（docs/screenshots/ に保存）
#   pip install playwright && python -m playwright install chromium
#   npm pack @fontsource/biz-udpgothic @fontsource/ibm-plex-mono  → 展開したフォルダを FONT_DIR に置く
#   python -m http.server 8765   （リポジトリのルートで起動しておく）
#   python tools/screenshots.py FONT_DIR PDF1 PDF2 ...
# 画面と同じ字体（BIZ UDPGothic・IBM Plex Mono）で撮るため、Google Fonts への要求を手元のフォントで返す。
# PDF は任意（撮影に使ったのは、スキャンした書類・写真の多い報告書・文字だけの一覧の 3 種類）
import sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'screenshots'
FONT_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else 'fonts')
PDFS = [Path(p) for p in sys.argv[2:]]
URL = 'http://localhost:8765/index.html'


def font_css():
    css = ''
    for pkg, files in [('biz-udpgothic', ['400.css', '700.css']), ('ibm-plex-mono', ['500.css'])]:
        base = next(FONT_DIR.glob(f'fontsource-{pkg}-*/package'))
        for f in files:
            css += re.sub(r'url\(\./files/([^)]+)\)', lambda m: f'url(https://fonts.local/{pkg}/{m.group(1)})', (base / f).read_text(encoding='utf-8'))
    return css


def route_fonts(page):
    css = font_css()
    page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=css))

    def serve(r):
        pkg, name = r.request.url.split('https://fonts.local/')[1].split('/', 1)
        path = next(FONT_DIR.glob(f'fontsource-{pkg}-*/package/files')) / name
        r.fulfill(status=200, content_type='font/woff2' if name.endswith('woff2') else 'font/woff', body=path.read_bytes())
    page.route('https://fonts.local/**', serve)


def idle(page):
    # すべてのファイルの処理が終わるまで待つ
    page.wait_for_function("() => document.querySelectorAll('#files > li').length && ![...document.querySelectorAll('#files .badge')].some(b => /待機|圧縮中|読込/.test(b.textContent))", timeout=180000)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1000, 'height': 900}, device_scale_factor=1)
    route_fonts(pg)
    pg.goto(URL)
    pg.evaluate('localStorage.clear()'); pg.reload(); pg.wait_for_load_state('networkidle')
    pg.evaluate('document.fonts.ready')
    OUT.mkdir(parents=True, exist_ok=True)
    pg.set_input_files('#fileInput', [{'name': f.name, 'mimeType': 'application/pdf', 'buffer': f.read_bytes()} for f in PDFS])
    idle(pg)
    pg.add_style_tag(content='header.top{position:static!important}')
    pg.mouse.move(0, 0)
    pg.screenshot(path=str(OUT / 'main.png'), full_page=True)
    # 画質の確認（最初のファイル）
    pg.locator('#files > li').first.locator('button', has_text='画質を確認').click()
    pg.wait_for_function("() => document.querySelectorAll('#compare img').length === 2 && !document.querySelector('#compare .wait') && [...document.querySelectorAll('#compare img')].every(i => i.complete && i.naturalWidth)", timeout=60000)
    pg.locator('#cmpA').evaluate('v => { v.scrollTop = 300; v.scrollLeft = 150; }')
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / 'compare.png'))
    b.close()
print('docs/screenshots/ に保存しました')
