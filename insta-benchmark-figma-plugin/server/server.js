const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parseInstagramHtml } = require('./parse-instagram');

const PORT = 3457;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.wasm': 'application/wasm',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function serveStatic(res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

async function fetchInstagramHtml(url) {
  // Instagram serves a generic login/challenge shell (no og:image) to plain
  // HTTP requests like fetch()/curl — it fingerprints the TLS handshake and
  // header set, not just the User-Agent string. A real (headless) browser
  // engine gets the actual server-rendered post page instead.
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      throw new Error(`INSTAGRAM_FETCH_FAILED:${err.message}`);
    }
    if (!response || !response.ok()) {
      throw new Error(`INSTAGRAM_FETCH_FAILED:${response ? response.status() : 'no-response'}`);
    }
    // Unlike a raw fetch(), Playwright follows redirects like a real browser.
    // Re-validate the post-redirect host so an instagram.com URL can't hop
    // to an arbitrary host and have its content read back through /parse.
    const finalHost = new URL(page.url()).hostname;
    if (!/(^|\.)instagram\.com$/.test(finalHost)) {
      throw new Error(`INSTAGRAM_FETCH_FAILED:redirected-off-instagram:${finalHost}`);
    }
    // Give Instagram's SSR meta tags a moment to settle after initial load.
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await context.close();
  }
}

async function handleParse(req, res, parsedUrl) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'url 쿼리 파라미터가 필요해요' }));
    return;
  }
  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '올바른 URL 형식이 아니에요' }));
    return;
  }
  if (parsedTarget.protocol !== 'https:' || !/(^|\.)instagram\.com$/.test(parsedTarget.hostname)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '인스타그램 게시물 링크만 지원해요' }));
    return;
  }
  try {
    const html = await fetchInstagramHtml(target);
    const data = parseInstagramHtml(html);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    const message = err.message.startsWith('INSTAGRAM_FETCH_FAILED')
      ? '게시물을 가져오지 못했어요. 링크가 맞는지, 비공개 계정은 아닌지 확인해주세요.'
      : err.message === 'NO_IMAGE_FOUND'
        ? '이미지를 찾을 수 없어요. 삭제되었거나 비공개 게시물일 수 있어요.'
        : `파싱 오류: ${err.message}`;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message }));
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && parsedUrl.pathname === '/parse') {
    await handleParse(req, res, parsedUrl);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, parsedUrl.pathname);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`로컬 서버 실행 중: http://localhost:${PORT}`);
});
