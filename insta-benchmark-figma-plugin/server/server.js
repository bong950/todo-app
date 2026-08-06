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
  // Chrome's Private Network Access policy blocks fetches from a
  // remote/opaque-origin document (e.g. Figma's plugin UI iframe) to a
  // loopback address like localhost unless the server explicitly opts in.
  // Without this, ui-app.js's own fetch()/dynamic import() of this server
  // (including the SAM library) fails silently.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
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

    const carouselImages = await collectCarouselImages(page);

    let html = await page.content();
    if (carouselImages.length > 0) {
      // parse-instagram.js's extractCarouselImages already looks for this
      // exact "display_url" JSON pattern (it used to come from Instagram's
      // own page-embedded JSON; that's gone from current markup, so we
      // collect the images ourselves via live carousel navigation below and
      // splice them back in using the same, already-tested pattern instead
      // of touching the parser).
      const injected = JSON.stringify(carouselImages.map((src) => ({ display_url: src })));
      html += `<script>window.__carouselItems = ${injected};</script>`;
    }
    return html;
  } finally {
    await context.close();
  }
}

async function collectCarouselImages(page) {
  // Only real carousels have a "Next" button; a single-image post has none,
  // and querying document-wide for it would also pick up unrelated
  // "suggested posts" thumbnails elsewhere on the page.
  const nextBtnHandle = await page.$('button[aria-label="Next"]');
  if (!nextBtnHandle) return [];

  // Lock onto the carousel's own container ONCE, from the Next button we
  // just confirmed exists, and reuse this same element handle for every
  // iteration below — including the final one, once Next has disappeared.
  // Re-deriving "the container" fresh each time by re-querying for the Next
  // button (as an earlier version of this function did) falls back to a
  // page-wide selector on that last iteration, which also picks up
  // unrelated "suggested post" thumbnails elsewhere on the page.
  const containerHandle = await page.evaluateHandle((btn) => btn.parentElement, nextBtnHandle);

  let refPrefix = null;
  const collected = [];
  const seen = new Set();
  const MAX_SLIDES = 12; // Instagram caps real carousels at 10

  for (let i = 0; i < MAX_SLIDES; i++) {
    const imgs = await page.evaluate((container) => {
      if (!container) return [];
      return [...container.querySelectorAll('img[alt^="Photo by"]')].map((img) => ({
        alt: img.alt,
        src: img.currentSrc || img.src,
      }));
    }, containerHandle);

    // The carousel container can also pick up neighboring "suggested post"
    // thumbnails once a few slides in. Every real slide of THIS post shares
    // the same "Photo by {author} on {date}." alt prefix (the post's own
    // publish date) — lock onto it from the first slide and filter by it.
    if (refPrefix === null && imgs.length) {
      const m = imgs[0].alt.match(/^(Photo by .+? on [^.]+\.)/);
      refPrefix = m ? m[1] : imgs[0].alt;
    }

    for (const img of imgs) {
      if (refPrefix && !img.alt.startsWith(refPrefix)) continue;
      if (!seen.has(img.src)) {
        seen.add(img.src);
        collected.push(img.src);
      }
    }

    const hasNext = await containerHandle.$('button[aria-label="Next"]');
    if (!hasNext) break;
    // A login-nag overlay sits on top of the Next button for logged-out
    // sessions and blocks a real Playwright click; dispatching the click
    // directly on the button element bypasses that visual obstruction.
    await page.evaluate((container) => {
      const btn = container.querySelector('button[aria-label="Next"]');
      if (btn) btn.click();
    }, containerHandle);
    await page.waitForTimeout(1000);
  }

  return collected;
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
