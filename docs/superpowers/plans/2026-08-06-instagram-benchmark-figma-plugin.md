# 인스타 벤치마킹 피그마 플러그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인스타그램 게시물 링크를 붙여넣으면 이미지+캡션이 피그마에 자동 정렬되고, 캔버스의 이미지를 클릭 한 번으로 오브젝트 단위 레이어로 분리("매직레이어")할 수 있는 피그마 플러그인을 만든다.

**Architecture:** Figma 플러그인(`code.js` 메인 스레드 + `ui.html`/UI iframe) + 로컬 Node 서버(`server/server.js`)로 구성된다. 로컬 서버는 (1) 인스타그램 게시물 페이지를 서버사이드로 fetch해 이미지/캡션을 파싱하는 `/parse` API와, (2) 플러그인 UI가 절대 URL(`http://localhost:3457/...`)로 불러오는 JS 파일들(우리 UI 코드 + 벤더 SAM 라이브러리)을 정적으로 서빙하는 역할을 겸한다. Figma의 `ui.html`은 상대 경로 `<script src>`를 지원하지 않고 절대 `http(s)://` URL만 허용하므로(공식 문서 확인됨), 이 로컬 서버가 정적 파일 서버 역할까지 맡는 구조가 필수적이다. 세그멘테이션은 `transformers.js`(SAM, `Xenova/slimsam-77-uniform`)로 플러그인 UI 안의 Web Worker에서 전부 클라이언트 사이드로 처리한다.

**Tech Stack:** Node.js(내장 `http`/`fetch`/`node:test`, 외부 런타임 의존성 없음), Figma Plugin API(plain JS, 빌드 도구 없음), `@huggingface/transformers` 3.7.6(SAM 브라우저 추론용으로 벤더링만, 런타임 의존성 아님).

## Global Constraints

- 로컬 실행만, 유료 API/서비스 의존 없음 (스펙: "돈이 들지 않고, 로컬에서 완전히 동작해야 한다")
- 로컬 서버 기본 포트: `3457`
- SAM 모델: `Xenova/slimsam-77-uniform` (`@huggingface/transformers` 3.7.6), WASM/WebGPU 브라우저 내 추론
- v1 범위: 배경 구멍은 투명 처리만, AI 인페인팅 없음 (스펙 비목표)
- 인스타 캡션은 텍스트 레이어로 함께 가져오되, 폰트/서체 복제는 하지 않음 (시스템 기본 폰트 `Inter`)
- 캐러셀 이미지는 가로로 나란히 배치
- 자동 테스트는 인스타 HTML 파서 모듈(`server/parse-instagram.js`)에 한해서만 작성한다 (Node 내장 `node:test`). Figma 플러그인 UI/SAM 상호작용/이미지 임포트 등 나머지는 기존 자매 프로젝트(`depth-openpose-extractor`, `like-collage`) 컨벤션과 동일하게 수동 검증한다 — 스펙에서 사용자 승인됨
- 프로젝트 위치: `/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin/` (워크스페이스 루트의 다른 프로젝트들과 같은 레벨)

---

## Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `insta-benchmark-figma-plugin/package.json`
- Create: `insta-benchmark-figma-plugin/.gitignore`
- Create: `insta-benchmark-figma-plugin/server/public/lib/.gitkeep`

**Interfaces:**
- Produces: `npm install`, `npm run server`, `npm test`, `npm run vendor:sam` 스크립트 (이후 모든 태스크가 사용)

- [ ] **Step 1: 디렉토리 구조 생성**

```bash
mkdir -p "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin/server/public/lib"
```

- [ ] **Step 2: `package.json` 작성**

```json
{
  "name": "insta-benchmark-figma-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "인스타그램 게시물 벤치마킹용 피그마 플러그인 (링크 임포트 + 매직레이어 오브젝트 분리)",
  "scripts": {
    "server": "node server/server.js",
    "test": "node --test server/",
    "vendor:sam": "cp node_modules/@huggingface/transformers/dist/transformers.min.js server/public/lib/transformers.min.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "devDependencies": {
    "@huggingface/transformers": "3.7.6"
  }
}
```

- [ ] **Step 3: `.gitignore` 작성**

```
node_modules/
server/public/lib/*.js
server/public/lib/*.js.map
```

- [ ] **Step 4: `server/public/lib/.gitkeep` 생성 (빈 파일)**

빈 파일로 생성한다 (라이브러리 파일은 `.gitignore`로 제외되지만 디렉토리 자체는 git에 남기기 위함).

- [ ] **Step 5: `npm install` 실행해 devDependency 설치 확인**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && npm install`
Expected: `node_modules/@huggingface/transformers` 설치됨, 에러 없음

- [ ] **Step 6: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add package.json .gitignore server/public/lib/.gitkeep
git commit -m "chore: scaffold insta-benchmark-figma-plugin project"
```

---

## Task 2: 인스타그램 HTML 파서 모듈 (TDD)

인스타그램 게시물 페이지 HTML에서 이미지 URL(들), 캡션, 작성자를 추출하는 순수 함수 모듈. 스펙에서 "인스타그램 HTML 구조는 예고 없이 바뀔 수 있어 파싱 로직이 깨질 수 있음 → 별도 모듈로 분리해 유지보수 용이하게 구성"이라고 명시했으므로, 이 모듈만 자동 테스트를 둔다. `og:image`/`og:description`/`og:title` 메타 태그(안정적인 Open Graph 표준)를 1차 소스로 쓰고, 캐러셀 추가 이미지는 페이지에 내장된 `"display_url":"..."` JSON 패턴을 best-effort로 스캔한다(찾지 못하면 대표 이미지 1장으로 degrade).

**Files:**
- Create: `insta-benchmark-figma-plugin/server/parse-instagram.js`
- Test: `insta-benchmark-figma-plugin/server/parse-instagram.test.js`

**Interfaces:**
- Produces: `parseInstagramHtml(html: string) -> { images: string[], caption: string, author: string }`, throws `Error('NO_IMAGE_FOUND')` if no `og:image` found. Also exports `extractAuthor(ogTitle: string|null) -> string|null` for direct testing.
- Consumes: nothing (pure function, no I/O)

- [ ] **Step 1: 실패하는 테스트 작성**

`insta-benchmark-figma-plugin/server/parse-instagram.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInstagramHtml, extractAuthor } = require('./parse-instagram');

test('단일 이미지 게시물에서 이미지/캡션/작성자를 추출한다', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="benchmarkuser on Instagram: &quot;오늘의 레이아웃&quot;" />
      <meta property="og:description" content="좋아요 1,234개 - benchmarkuser님의 게시물" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/single.jpg" />
    </head><body></body></html>
  `;
  const result = parseInstagramHtml(html);
  assert.deepEqual(result.images, ['https://scontent.cdninstagram.com/single.jpg']);
  assert.equal(result.author, 'benchmarkuser');
  assert.match(result.caption, /좋아요/);
});

test('캐러셀 게시물에서 display_url을 모두 추출한다', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="creator on Instagram" />
      <meta property="og:image" content="https://scontent.cdninstagram.com/cover.jpg" />
    </head><body>
      <script>
        window.__data = {"items":[
          {"display_url":"https:\\/\\/scontent.cdninstagram.com\\/slide1.jpg"},
          {"display_url":"https:\\/\\/scontent.cdninstagram.com\\/slide2.jpg"}
        ]};
      </script>
    </body></html>
  `;
  const result = parseInstagramHtml(html);
  assert.deepEqual(result.images, [
    'https://scontent.cdninstagram.com/slide1.jpg',
    'https://scontent.cdninstagram.com/slide2.jpg',
  ]);
});

test('og:image가 없으면 NO_IMAGE_FOUND 에러를 던진다', () => {
  const html = '<html><head></head><body>삭제된 게시물</body></html>';
  assert.throws(() => parseInstagramHtml(html), /NO_IMAGE_FOUND/);
});

test('extractAuthor는 "X on Instagram" 패턴에서 계정명을 뽑는다', () => {
  assert.equal(extractAuthor('cool.user on Instagram: "caption"'), 'cool.user');
  assert.equal(extractAuthor(null), null);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && node --test server/parse-instagram.test.js`
Expected: FAIL — `Cannot find module './parse-instagram'`

- [ ] **Step 3: 최소 구현 작성**

`insta-benchmark-figma-plugin/server/parse-instagram.js`:

```js
function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) {
      return match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }
  }
  return null;
}

function extractCarouselImages(html) {
  const matches = [...html.matchAll(/"display_url":"([^"]+)"/g)];
  const urls = matches.map((m) => m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  return [...new Set(urls)];
}

function extractAuthor(ogTitle) {
  if (!ogTitle) return null;
  const match = ogTitle.match(/^(.+?)\s+on Instagram/i);
  return match ? match[1].trim() : null;
}

function parseInstagramHtml(html) {
  const primaryImage = extractMetaContent(html, 'og:image');
  if (!primaryImage) {
    throw new Error('NO_IMAGE_FOUND');
  }

  const caption = extractMetaContent(html, 'og:description') || '';
  const ogTitle = extractMetaContent(html, 'og:title');
  const author = extractAuthor(ogTitle) || 'unknown';

  const carousel = extractCarouselImages(html);
  const images = carousel.length > 0 ? carousel : [primaryImage];

  return { images, caption, author };
}

module.exports = { parseInstagramHtml, extractMetaContent, extractCarouselImages, extractAuthor };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && node --test server/parse-instagram.test.js`
Expected: PASS — 4개 테스트 모두 통과

- [ ] **Step 5: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add server/parse-instagram.js server/parse-instagram.test.js
git commit -m "feat: add Instagram post HTML parser with tests"
```

---

## Task 3: 로컬 서버 (정적 파일 서빙 + `/parse` API)

**Files:**
- Create: `insta-benchmark-figma-plugin/server/server.js`

**Interfaces:**
- Consumes: `parseInstagramHtml` from Task 2 (`./parse-instagram.js`)
- Produces: `GET http://localhost:3457/parse?url=<instagram-post-url>` → `200 { images: string[], caption: string, author: string }` 또는 `4xx/5xx { message: string }`. `GET http://localhost:3457/<path>` → `server/public/<path>` 정적 파일 서빙 (다음 태스크들이 여기에 `ui-app.js`, `sam-worker.js`, `lib/transformers.min.js`를 둔다)

- [ ] **Step 1: `server/server.js` 작성**

```js
const http = require('http');
const fs = require('fs');
const path = require('path');
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

async function fetchInstagramHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`INSTAGRAM_FETCH_FAILED:${res.status}`);
  }
  return res.text();
}

async function handleParse(req, res, parsedUrl) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'url 쿼리 파라미터가 필요해요' }));
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
```

- [ ] **Step 2: 서버 기동 확인**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && node server/server.js &`
Expected: 콘솔에 `로컬 서버 실행 중: http://localhost:3457` 출력

- [ ] **Step 3: `/parse` 엔드포인트 수동 검증 (실제 공개 인스타 게시물 링크 필요)**

Run: `curl -s "http://localhost:3457/parse?url=<실제 공개 인스타 게시물 링크>" | head -c 500`
Expected: `{"images":["https://..."],"caption":"...","author":"..."}` 형태의 JSON 응답. (게시물 링크는 실행 시점에 유효한 공개 게시물로 직접 골라서 사용 — 특정 URL을 테스트에 고정하지 않는다, 링크는 언제든 삭제/비공개 전환될 수 있음)

- [ ] **Step 4: 에러 케이스 확인**

Run: `curl -s "http://localhost:3457/parse" ; echo`
Expected: `{"message":"url 쿼리 파라미터가 필요해요"}`

Run: `curl -s "http://localhost:3457/parse?url=https://instagram.com/p/존재하지않는게시물아이디아무거나12345" ; echo`
Expected: `{"message":"..."}` 형태의 502 에러 응답 (정확한 메시지는 인스타 응답에 따라 다름)

- [ ] **Step 5: 서버 종료**

Run: `kill %1` (Step 2에서 백그라운드로 띄운 프로세스 종료) 또는 실행 중인 터미널에서 `Ctrl+C`

- [ ] **Step 6: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add server/server.js
git commit -m "feat: add local server with Instagram parse API and static file serving"
```

---

## Task 4: Figma 플러그인 스켈레톤

Figma는 `ui.html`을 파일 그대로 읽어 `figma.showUI(__html__)`로 iframe에 주입하며, **상대 경로 `<script src="./file.js">`를 지원하지 않는다** (Figma 공식 문서/포럼 확인됨: 외부 리소스는 반드시 `http://` 또는 `https://` 절대 URL이어야 함). 따라서 `ui.html`은 얇은 셸로 두고, 실제 UI 로직은 Task 3의 로컬 서버가 서빙하는 `http://localhost:3457/ui-app.js`를 `<script type="module" src="...">`로 절대 URL 참조한다.

**Files:**
- Create: `insta-benchmark-figma-plugin/manifest.json`
- Create: `insta-benchmark-figma-plugin/code.js`
- Create: `insta-benchmark-figma-plugin/ui.html`
- Create: `insta-benchmark-figma-plugin/server/public/ui-app.js`

**Interfaces:**
- Produces: `code.js` ↔ `ui-app.js` 간 `figma.ui.postMessage` / `parent.postMessage({pluginMessage: {...}})` 메시지 통신 채널 (이후 태스크들이 `type` 필드로 메시지를 구분해 확장)

- [ ] **Step 1: `manifest.json` 작성**

```json
{
  "name": "인스타 벤치마킹",
  "id": "insta-benchmark-plugin",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "networkAccess": {
    "allowedDomains": [
      "http://localhost:3457",
      "https://*.cdninstagram.com",
      "https://*.fbcdn.net",
      "https://cdn.jsdelivr.net",
      "https://huggingface.co",
      "https://*.hf.co",
      "https://cdn-lfs.huggingface.co",
      "https://cdn-lfs-us-1.huggingface.co"
    ]
  }
}
```

- [ ] **Step 2: `code.js` 작성 (핑퐁 확인용)**

```js
figma.showUI(__html__, { width: 420, height: 640 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
  }
};
```

- [ ] **Step 3: `ui.html` 작성 (얇은 셸)**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: -apple-system, sans-serif; margin: 0; padding: 12px; font-size: 13px; }
  h3 { margin: 12px 0 8px; }
  input[type="text"] { width: 100%; box-sizing: border-box; padding: 6px; margin-bottom: 8px; }
  button { padding: 6px 12px; cursor: pointer; margin-right: 6px; }
  #status { color: #666; margin-top: 8px; white-space: pre-wrap; }
  #editor-canvas { border: 1px solid #ddd; max-width: 100%; cursor: crosshair; display: block; margin-bottom: 8px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div id="app">
    <section id="import-section">
      <h3>1. 게시물 임포트</h3>
      <form id="import-form">
        <input id="post-url" type="text" placeholder="인스타그램 게시물 링크" />
        <button type="submit">가져오기</button>
      </form>
    </section>

    <section id="magic-layer-section">
      <h3>2. 매직레이어</h3>
      <button id="magic-layer-btn">선택한 이미지에서 오브젝트 분리</button>
      <div id="editor" class="hidden">
        <canvas id="editor-canvas"></canvas>
        <button id="extract-btn">추출</button>
        <button id="cancel-btn">취소</button>
        <button id="sam-retry-btn" class="hidden">재시도</button>
      </div>
    </section>

    <p id="status">로컬 서버(http://localhost:3457) 연결 확인 중...</p>
  </div>
  <script type="module" src="http://localhost:3457/ui-app.js"></script>
</body>
</html>
```

- [ ] **Step 4: `server/public/ui-app.js` 작성 (핑퐁 확인용 최소 버전)**

```js
function setStatus(text) {
  document.getElementById('status').textContent = text;
}

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  }
};

parent.postMessage({ pluginMessage: { type: 'ping' } }, '*');
```

- [ ] **Step 5: 로컬 서버 실행 후 Figma에서 플러그인 로드 및 수동 검증**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && node server/server.js` (터미널 하나에 계속 띄워둠)

Figma 데스크톱 앱에서:
1. 아무 파일이나 열기 → 상단 메뉴 `Plugins` → `Development` → `Import plugin from manifest...`
2. `insta-benchmark-figma-plugin/manifest.json` 선택
3. `Plugins` → `Development` → `인스타 벤치마킹` 실행

Expected: 우측에 플러그인 패널이 뜨고, 잠시 후 상태 텍스트가 "code.js와 통신 확인됨"으로 바뀜. (Figma 데스크톱 앱이 설치되어 있지 않다면 무료로 설치 필요 — https://www.figma.com/downloads/)

- [ ] **Step 6: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add manifest.json code.js ui.html server/public/ui-app.js
git commit -m "feat: add Figma plugin skeleton with code.js/ui.html ping-pong"
```

---

## Task 5: 링크 임포트 기능

**Files:**
- Modify: `insta-benchmark-figma-plugin/server/public/ui-app.js`
- Modify: `insta-benchmark-figma-plugin/code.js`

**Interfaces:**
- Consumes: Task 3의 `GET /parse` API, Task 4의 postMessage 채널
- Produces: UI → code.js 메시지 `{ type: 'import-post', images: number[][], caption: string, author: string }`. code.js → UI 메시지 `{ type: 'import-done', frameId: string }`

- [ ] **Step 1: `ui-app.js`에 링크 임포트 폼 로직 추가**

`server/public/ui-app.js`에 다음을 추가한다 (기존 핑퐁 코드는 유지):

```js
const importForm = document.getElementById('import-form');
const urlInput = document.getElementById('post-url');

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setStatus('가져오는 중...');
  try {
    const parseRes = await fetch(`http://localhost:3457/parse?url=${encodeURIComponent(url)}`);
    const data = await parseRes.json();
    if (!parseRes.ok) {
      throw new Error(data.message || `서버 오류 (${parseRes.status})`);
    }

    const imagePayloads = [];
    for (const imgUrl of data.images) {
      const imgRes = await fetch(imgUrl);
      const buf = new Uint8Array(await imgRes.arrayBuffer());
      imagePayloads.push(Array.from(buf));
    }

    parent.postMessage(
      {
        pluginMessage: {
          type: 'import-post',
          images: imagePayloads,
          caption: data.caption || '',
          author: data.author || 'unknown',
        },
      },
      '*',
    );

    setStatus(`이미지 ${imagePayloads.length}장 임포트 요청 보냄...`);
  } catch (err) {
    if (err instanceof TypeError) {
      setStatus('로컬 서버에 연결할 수 없어요. 터미널에서 `node server/server.js`를 실행해주세요.');
    } else {
      setStatus(`실패: ${err.message}`);
    }
  }
});
```

`window.onmessage` 핸들러에 `import-done` 케이스를 추가한다 (기존 `pong` 케이스 옆에):

```js
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  } else if (msg.type === 'import-done') {
    setStatus('임포트 완료!');
  }
};
```

- [ ] **Step 2: `code.js`에 프레임/이미지/캡션 생성 로직 추가**

```js
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
  } else if (msg.type === 'import-post') {
    await handleImportPost(msg);
  }
};

async function handleImportPost({ images, caption, author }) {
  const GAP = 24;
  const imageNodes = [];
  let xOffset = 0;
  let maxHeight = 0;

  for (const bytesArray of images) {
    const bytes = new Uint8Array(bytesArray);
    const image = figma.createImage(bytes);
    const size = await image.getSizeAsync();

    const rect = figma.createRectangle();
    rect.resize(size.width, size.height);
    rect.x = xOffset;
    rect.y = 0;
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    rect.name = '인스타 이미지';

    imageNodes.push(rect);
    xOffset += size.width + GAP;
    maxHeight = Math.max(maxHeight, size.height);
  }

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const captionText = figma.createText();
  captionText.fontName = { family: 'Inter', style: 'Regular' };
  captionText.characters = caption || '(캡션 없음)';
  const contentWidth = Math.max(xOffset - GAP, 320);
  captionText.resize(contentWidth, captionText.height);
  captionText.x = 0;
  captionText.y = maxHeight + GAP;

  const frame = figma.createFrame();
  frame.name = `${author}_${new Date().toISOString().slice(0, 10)}`;
  frame.resize(contentWidth, maxHeight + GAP + captionText.height + GAP);
  for (const node of [...imageNodes, captionText]) {
    frame.appendChild(node);
  }

  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);

  figma.ui.postMessage({ type: 'import-done', frameId: frame.id });
}
```

- [ ] **Step 3: 수동 E2E 검증 (단일 이미지 게시물)**

1. 로컬 서버 실행 중인지 확인 (`node server/server.js`)
2. Figma에서 플러그인 재실행 (`Plugins` → `Development` → `인스타 벤치마킹`) — 코드 변경 후에는 플러그인을 껐다 다시 켜야 반영됨
3. 실제 공개 인스타 게시물(단일 이미지) 링크를 입력창에 붙여넣고 "가져오기" 클릭

Expected: 캔버스에 `{계정명}_{날짜}` 이름의 프레임이 생기고, 그 안에 실제 픽셀 크기의 이미지 1장 + 캡션 텍스트가 배치됨. 상태 텍스트가 "임포트 완료!"로 바뀜

- [ ] **Step 4: 수동 E2E 검증 (캐러셀 게시물)**

같은 방식으로 캐러셀(여러 장) 게시물 링크로 테스트

Expected: 프레임 안에 이미지 여러 장이 가로로 나란히 배치됨, 캡션은 이미지들 아래 1개

- [ ] **Step 5: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add server/public/ui-app.js code.js
git commit -m "feat: implement Instagram link import into Figma canvas"
```

---

## Task 6: SAM 라이브러리 벤더링

`@huggingface/transformers` 3.7.6의 브라우저용 ESM 번들(`dist/transformers.min.js`, 856KB)을 로컬 서버가 정적으로 서빙하도록 복사해둔다. 이 번들은 실행 시 ONNX WASM 런타임을 `https://cdn.jsdelivr.net`에서, SAM 모델 가중치를 `https://huggingface.co`에서 자동으로 내려받고 브라우저 캐시에 저장한다 (번들 내부에 이미 기본값으로 박혀있음 — 직접 확인함). 그래서 이 두 파일 자체는 벤더링하지 않고, 라이브러리 진입점만 벤더링하면 된다.

**Files:**
- Create (스크립트로 생성, git 추적 안 함): `insta-benchmark-figma-plugin/server/public/lib/transformers.min.js`

**Interfaces:**
- Produces: `http://localhost:3457/lib/transformers.min.js` — Task 8의 `sam-worker.js`가 `import`할 대상

- [ ] **Step 1: 벤더 스크립트 실행**

Run: `cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin" && npm run vendor:sam`
Expected: `server/public/lib/transformers.min.js` 파일 생성됨 (약 850KB)

- [ ] **Step 2: 파일이 서빙되는지 확인**

Run: `node server/server.js &` 후 `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3457/lib/transformers.min.js`
Expected: `200 application/javascript; charset=utf-8`

Run: `kill %1`

- [ ] **Step 3: `export` 심볼이 포함되어 있는지 확인 (ESM 번들 검증)**

Run: `grep -c "SamModel" "server/public/lib/transformers.min.js"`
Expected: `1` 이상의 숫자 출력

- [ ] **Step 4: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git status
```

`server/public/lib/transformers.min.js`는 `.gitignore`로 제외되므로 커밋할 파일이 없다 (README에 `npm run vendor:sam` 실행이 셋업 단계임을 명시 — Task 10에서 작성). 이 태스크는 커밋 없이 다음 태스크로 진행한다.

---

## Task 7: 매직레이어 — 선택 캡처

캔버스에서 이미지가 있는 레이어를 선택하고 "매직레이어" 버튼을 누르면, 그 이미지를 PNG로 export해 플러그인 UI 안의 편집 캔버스에 띄운다.

**Files:**
- Modify: `insta-benchmark-figma-plugin/code.js`
- Modify: `insta-benchmark-figma-plugin/server/public/ui-app.js`

**Interfaces:**
- Consumes: Task 4의 postMessage 채널
- Produces: UI → code.js `{ type: 'request-magic-layer' }`. code.js → UI `{ type: 'magic-layer-source', imageBytes: number[], nodeId: string, x, y, width, height }` / `{ type: 'magic-layer-error', message: string }` / `{ type: 'selection-state', hasImageFill: boolean }` (선택이 바뀔 때마다 자동 발신)

- [ ] **Step 1: `code.js`에 선택 노드 export 로직 추가**

`figma.ui.onmessage` 안에 분기 추가:

```js
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
  } else if (msg.type === 'import-post') {
    await handleImportPost(msg);
  } else if (msg.type === 'request-magic-layer') {
    await handleMagicLayerRequest();
  }
};

async function handleMagicLayerRequest() {
  const selection = figma.currentPage.selection;
  const node = selection[0];
  const hasImageFill =
    selection.length === 1 && node && 'fills' in node && Array.isArray(node.fills) && node.fills.some((f) => f.type === 'IMAGE');

  if (!hasImageFill) {
    figma.ui.postMessage({ type: 'magic-layer-error', message: '이미지가 있는 레이어를 하나만 선택해주세요.' });
    return;
  }

  const bytes = await node.exportAsync({ format: 'PNG' });
  figma.ui.postMessage({
    type: 'magic-layer-source',
    imageBytes: Array.from(bytes),
    nodeId: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  });
}
```

- [ ] **Step 2: `ui-app.js`에 매직레이어 버튼 및 편집 캔버스 렌더링 추가**

```js
let sourceNodeMeta = null;
let currentImageBitmap = null;

document.getElementById('magic-layer-btn').addEventListener('click', () => {
  parent.postMessage({ pluginMessage: { type: 'request-magic-layer' } }, '*');
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  document.getElementById('editor').classList.add('hidden');
  sourceNodeMeta = null;
  currentImageBitmap = null;
});

async function openMagicLayerEditor(msg) {
  sourceNodeMeta = { nodeId: msg.nodeId, x: msg.x, y: msg.y, width: msg.width, height: msg.height };

  const blob = new Blob([new Uint8Array(msg.imageBytes)], { type: 'image/png' });
  currentImageBitmap = await createImageBitmap(blob);

  const canvas = document.getElementById('editor-canvas');
  const scale = Math.min(360 / currentImageBitmap.width, 1);
  canvas.width = currentImageBitmap.width * scale;
  canvas.height = currentImageBitmap.height * scale;
  canvas.getContext('2d').drawImage(currentImageBitmap, 0, 0, canvas.width, canvas.height);

  document.getElementById('editor').classList.remove('hidden');
  setStatus('이미지 준비됨');
}
```

`window.onmessage` 핸들러에 케이스 추가:

```js
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  } else if (msg.type === 'import-done') {
    setStatus('임포트 완료!');
  } else if (msg.type === 'magic-layer-source') {
    openMagicLayerEditor(msg);
  } else if (msg.type === 'magic-layer-error') {
    setStatus(msg.message);
  }
};
```

- [ ] **Step 3: 선택 상태에 따라 버튼 활성/비활성 (스펙의 "이미지가 아닌 노드 선택 시 매직레이어 비활성화" 요구사항)**

`code.js` 최상단, `figma.showUI(...)` 다음 줄에 선택 변경 리스너를 추가한다:

```js
figma.on('selectionchange', () => {
  postSelectionState();
});

function postSelectionState() {
  const selection = figma.currentPage.selection;
  const node = selection[0];
  const hasImageFill =
    selection.length === 1 && node && 'fills' in node && Array.isArray(node.fills) && node.fills.some((f) => f.type === 'IMAGE');
  figma.ui.postMessage({ type: 'selection-state', hasImageFill });
}
```

`handleMagicLayerRequest` 안의 중복된 선택 검사 로직은 `postSelectionState`와 별개로 그대로 둔다 (버튼이 비활성화돼도 방어적으로 서버 사이드 재검증은 유지).

`ui-app.js`에 버튼 상태 반영 로직 추가:

```js
const magicLayerBtn = document.getElementById('magic-layer-btn');
magicLayerBtn.disabled = true;
```

`window.onmessage` 핸들러를 아래 내용으로 전체 교체한다 (`selection-state` 분기만 새로 추가):

```js
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  } else if (msg.type === 'import-done') {
    setStatus('임포트 완료!');
  } else if (msg.type === 'magic-layer-source') {
    openMagicLayerEditor(msg);
  } else if (msg.type === 'magic-layer-error') {
    setStatus(msg.message);
  } else if (msg.type === 'selection-state') {
    magicLayerBtn.disabled = !msg.hasImageFill;
  }
};
```

- [ ] **Step 4: 수동 검증**

1. 로컬 서버 실행, Figma에서 플러그인 재실행
2. 아무것도 선택하지 않은 상태 → "선택한 이미지에서 오브젝트 분리" 버튼이 비활성화되어 있는지 확인
3. Task 5로 임포트해둔 이미지 레이어 하나를 캔버스에서 선택 → 버튼이 활성화되는지 확인, 클릭

Expected: 플러그인 패널 안 편집 캔버스에 선택한 이미지가 렌더됨, 상태 텍스트 "이미지 준비됨"

4. 텍스트 레이어 등 이미지가 아닌 노드를 선택 → 버튼이 다시 비활성화되는지 확인

- [ ] **Step 5: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add code.js server/public/ui-app.js
git commit -m "feat: capture selected image node for magic layer editing"
```

---

## Task 8: 매직레이어 — SAM 세그멘테이션 (클릭 → 마스크)

`transformers.js` 공식 SAM 데모(`Xenova/segment-anything-web`)와 동일한 Web Worker 패턴을 사용한다 (실제 소스 확인 후 우리 구조에 맞게 이식). 이미지는 1회만 인코딩하고, 클릭할 때마다 디코딩만 다시 실행해 빠르게 반응한다.

**Files:**
- Create: `insta-benchmark-figma-plugin/server/public/sam-worker.js`
- Modify: `insta-benchmark-figma-plugin/server/public/ui-app.js`

**Interfaces:**
- Consumes: Task 6의 `http://localhost:3457/lib/transformers.min.js`
- Produces: `sam-worker.js`가 받는 메시지 `{ type: 'segment', data: ArrayBuffer }`(PNG 바이트) / `{ type: 'decode', data: [{point: [xNorm, yNorm], label: 0|1}, ...] }`. 보내는 메시지 `{ type: 'ready' }` / `{ type: 'segment_result', data: 'start'|'done' }` / `{ type: 'decode_result', data: { mask: {data, width, height}, scores } }` / `{ type: 'error', message: string, retry: {type, data} }`

- [ ] **Step 1: `sam-worker.js` 작성**

```js
import { env, SamModel, AutoProcessor, RawImage, Tensor } from './lib/transformers.min.js';

env.allowLocalModels = false;

const MODEL_ID = 'Xenova/slimsam-77-uniform';
let model = null;
let processor = null;
let image_inputs = null;
let image_embeddings = null;

async function getModelAndProcessor() {
  if (!model) model = await SamModel.from_pretrained(MODEL_ID, { quantized: true });
  if (!processor) processor = await AutoProcessor.from_pretrained(MODEL_ID);
  return [model, processor];
}

let readyPosted = false;

self.onmessage = async (e) => {
  const { type, data } = e.data;

  try {
    const [m, p] = await getModelAndProcessor();
    if (!readyPosted) {
      readyPosted = true;
      self.postMessage({ type: 'ready' });
    }

    if (type === 'segment') {
      self.postMessage({ type: 'segment_result', data: 'start' });
      const blob = new Blob([data], { type: 'image/png' });
      const image = await RawImage.fromBlob(blob);
      image_inputs = await p(image);
      image_embeddings = await m.get_image_embeddings(image_inputs);
      self.postMessage({ type: 'segment_result', data: 'done' });
    } else if (type === 'decode') {
      const reshaped = image_inputs.reshaped_input_sizes[0];
      const points = data.map((pt) => [pt.point[0] * reshaped[1], pt.point[1] * reshaped[0]]);
      const labels = data.map((pt) => BigInt(pt.label));
      const input_points = new Tensor('float32', points.flat(Infinity), [1, 1, points.length, 2]);
      const input_labels = new Tensor('int64', labels.flat(Infinity), [1, 1, labels.length]);
      const outputs = await m({ ...image_embeddings, input_points, input_labels });
      const masks = await p.post_process_masks(outputs.pred_masks, image_inputs.original_sizes, image_inputs.reshaped_input_sizes);
      const maskImage = RawImage.fromTensor(masks[0][0]);
      self.postMessage({
        type: 'decode_result',
        data: {
          mask: { data: maskImage.data, width: maskImage.width, height: maskImage.height },
          scores: Array.from(outputs.iou_scores.data),
        },
      });
    }
  } catch (err) {
    // 모델/가중치 다운로드 실패(오프라인 등) 또는 추론 중 오류. UI가 재시도 버튼을 보여줄 수 있도록
    // 실패한 원본 메시지(type, data)를 그대로 돌려보낸다.
    self.postMessage({ type: 'error', message: err.message, retry: { type, data } });
  }
};
```

- [ ] **Step 2: `ui-app.js`에 워커 연결 + 클릭 인터랙션 추가**

```js
let samWorker = null;
let points = [];
let lastMask = null;

function getSamWorker() {
  if (!samWorker) {
    samWorker = new Worker('http://localhost:3457/sam-worker.js', { type: 'module' });
    samWorker.onmessage = handleSamMessage;
  }
  return samWorker;
}

let lastFailedMessage = null;

function handleSamMessage(e) {
  const msg = e.data;
  if (msg.type === 'ready') {
    setStatus('SAM 모델 준비됨 (최초 1회는 모델 다운로드로 시간이 걸릴 수 있어요)');
  } else if (msg.type === 'segment_result') {
    if (msg.data === 'start') setStatus('이미지 인코딩 중...');
    if (msg.data === 'done') setStatus('오브젝트를 클릭하세요 (Shift+클릭 = 마이너스 포인트)');
  } else if (msg.type === 'decode_result') {
    lastMask = msg.data.mask;
    drawMaskOverlay(msg.data.mask);
  } else if (msg.type === 'error') {
    lastFailedMessage = msg.retry;
    setStatus(`모델 처리 중 오류가 발생했어요: ${msg.message}`);
    document.getElementById('sam-retry-btn').classList.remove('hidden');
  }
}

document.getElementById('sam-retry-btn').addEventListener('click', () => {
  if (!lastFailedMessage) return;
  document.getElementById('sam-retry-btn').classList.add('hidden');
  setStatus('재시도 중...');
  getSamWorker().postMessage(lastFailedMessage);
});

function drawMaskOverlay(mask) {
  const canvas = document.getElementById('editor-canvas');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(currentImageBitmap, 0, 0, canvas.width, canvas.height);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mask.width;
  maskCanvas.height = mask.height;
  const maskCtx = maskCanvas.getContext('2d');
  const imageData = maskCtx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.width * mask.height; i++) {
    const on = mask.data[i] > 0;
    imageData.data[i * 4 + 0] = 255;
    imageData.data[i * 4 + 1] = 0;
    imageData.data[i * 4 + 2] = 128;
    imageData.data[i * 4 + 3] = on ? 120 : 0;
  }
  maskCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
}

document.getElementById('editor-canvas').addEventListener('click', (e) => {
  if (!currentImageBitmap) return;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const xNorm = (e.clientX - rect.left) / rect.width;
  const yNorm = (e.clientY - rect.top) / rect.height;
  const label = e.shiftKey ? 0 : 1;
  points.push({ point: [xNorm, yNorm], label });
  getSamWorker().postMessage({ type: 'decode', data: points });
});
```

`openMagicLayerEditor` 함수(Task 7에서 작성) 맨 앞부분에 포인트 초기화와 세그멘테이션 시작 코드를 추가한다:

```js
async function openMagicLayerEditor(msg) {
  sourceNodeMeta = { nodeId: msg.nodeId, x: msg.x, y: msg.y, width: msg.width, height: msg.height };
  points = [];
  lastMask = null;

  const blob = new Blob([new Uint8Array(msg.imageBytes)], { type: 'image/png' });
  currentImageBitmap = await createImageBitmap(blob);

  const canvas = document.getElementById('editor-canvas');
  const scale = Math.min(360 / currentImageBitmap.width, 1);
  canvas.width = currentImageBitmap.width * scale;
  canvas.height = currentImageBitmap.height * scale;
  canvas.getContext('2d').drawImage(currentImageBitmap, 0, 0, canvas.width, canvas.height);

  document.getElementById('editor').classList.remove('hidden');
  setStatus('이미지 인코딩 중...');

  const buf = await blob.arrayBuffer();
  getSamWorker().postMessage({ type: 'segment', data: buf });
}
```

(이 함수는 새로 만드는 게 아니라 Task 7에서 작성한 버전을 이 내용으로 교체하는 것이다.)

- [ ] **Step 3: 수동 검증**

1. 로컬 서버 실행, Figma에서 플러그인 재실행
2. 이미지 레이어 선택 → "매직레이어" 클릭 → 편집 캔버스 열림
3. 콘솔/상태 텍스트로 "이미지 인코딩 중..." → "오브젝트를 클릭하세요" 순서로 바뀌는지 확인 (최초 실행 시 모델 다운로드로 수십 초 걸릴 수 있음, Figma 플러그인 콘솔은 플러그인 실행 중 `Plugins` → `Development` → `Open Console`로 확인 가능)
4. 이미지 속 오브젝트 하나를 클릭 → 빨간 반투명 마스크 오버레이가 그 오브젝트 위에 표시되는지 확인
5. Shift+클릭으로 마스크에서 빼고 싶은 영역을 클릭 → 마스크가 줄어드는지 확인

Expected: 클릭한 오브젝트 경계를 따라 마스크가 표시됨. 완벽하지 않아도 되며(v1), 추가 클릭으로 다듬어지는 것만 확인

- [ ] **Step 4: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add server/public/sam-worker.js server/public/ui-app.js
git commit -m "feat: add SAM-based interactive segmentation in magic layer editor"
```

---

## Task 9: 매직레이어 — 추출 (레이어 분리 적용)

확정된 마스크로 오브젝트를 알파 채널 있는 PNG로 잘라내고, 원본 이미지의 그 영역은 투명하게 뚫어 두 PNG를 code.js로 전달한다. code.js는 원본 노드의 이미지를 "구멍 뚫린 PNG"로 교체하고, 그 위에 원본과 같은 위치/크기의 새 이미지 노드를 "잘라낸 PNG"로 만든다.

**Files:**
- Modify: `insta-benchmark-figma-plugin/server/public/ui-app.js`
- Modify: `insta-benchmark-figma-plugin/code.js`

**Interfaces:**
- Consumes: Task 8의 `lastMask`, Task 7의 `sourceNodeMeta`
- Produces: UI → code.js `{ type: 'apply-magic-layer', nodeId, x, y, width, height, cutoutBytes: number[], backgroundBytes: number[] }`. code.js → UI `{ type: 'magic-layer-done' }` 또는 `{ type: 'magic-layer-error', message }`

- [ ] **Step 1: `ui-app.js`에 추출 로직 추가**

```js
async function imageDataToPngBytes(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

document.getElementById('extract-btn').addEventListener('click', async () => {
  if (!lastMask || !currentImageBitmap || !sourceNodeMeta) {
    setStatus('먼저 오브젝트를 클릭해서 마스크를 만들어주세요.');
    return;
  }

  setStatus('레이어 분리 중...');

  const w = currentImageBitmap.width;
  const h = currentImageBitmap.height;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(currentImageBitmap, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, w, h);

  const cutoutData = new ImageData(new Uint8ClampedArray(srcData.data), w, h);
  const bgData = new ImageData(new Uint8ClampedArray(srcData.data), w, h);

  for (let i = 0; i < w * h; i++) {
    const maskOn = lastMask.data[i] > 0;
    if (maskOn) {
      bgData.data[i * 4 + 3] = 0;
    } else {
      cutoutData.data[i * 4 + 3] = 0;
    }
  }

  const cutoutBytes = await imageDataToPngBytes(cutoutData);
  const bgBytes = await imageDataToPngBytes(bgData);

  parent.postMessage(
    {
      pluginMessage: {
        type: 'apply-magic-layer',
        nodeId: sourceNodeMeta.nodeId,
        x: sourceNodeMeta.x,
        y: sourceNodeMeta.y,
        width: sourceNodeMeta.width,
        height: sourceNodeMeta.height,
        cutoutBytes: Array.from(cutoutBytes),
        backgroundBytes: Array.from(bgBytes),
      },
    },
    '*',
  );

  document.getElementById('editor').classList.add('hidden');
});
```

`window.onmessage` 핸들러를 아래 내용으로 전체 교체한다 (`magic-layer-done` 분기만 새로 추가, `magic-layer-error`는 Task 7에서 이미 추가되어 있음):

```js
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  } else if (msg.type === 'import-done') {
    setStatus('임포트 완료!');
  } else if (msg.type === 'magic-layer-source') {
    openMagicLayerEditor(msg);
  } else if (msg.type === 'magic-layer-error') {
    setStatus(msg.message);
  } else if (msg.type === 'selection-state') {
    magicLayerBtn.disabled = !msg.hasImageFill;
  } else if (msg.type === 'magic-layer-done') {
    setStatus('레이어 분리 완료!');
  }
};
```

- [ ] **Step 2: `code.js`에 적용 로직 추가**

`figma.ui.onmessage`를 아래 내용으로 전체 교체한다 (기존 `ping`/`import-post`/`request-magic-layer` 분기 유지, `apply-magic-layer` 분기만 새로 추가):

```js
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
  } else if (msg.type === 'import-post') {
    await handleImportPost(msg);
  } else if (msg.type === 'request-magic-layer') {
    await handleMagicLayerRequest();
  } else if (msg.type === 'apply-magic-layer') {
    await handleApplyMagicLayer(msg);
  }
};
```

`handleApplyMagicLayer` 함수는 파일 하단에 새로 추가한다:

```js
async function handleApplyMagicLayer(msg) {
  const { nodeId, x, y, width, height, cutoutBytes, backgroundBytes } = msg;
  const originalNode = await figma.getNodeByIdAsync(nodeId);
  if (!originalNode) {
    figma.ui.postMessage({ type: 'magic-layer-error', message: '원본 레이어를 찾을 수 없어요 (삭제되었을 수 있어요).' });
    return;
  }

  const bgImage = figma.createImage(new Uint8Array(backgroundBytes));
  originalNode.fills = [{ type: 'IMAGE', imageHash: bgImage.hash, scaleMode: 'FILL' }];

  const cutoutImage = figma.createImage(new Uint8Array(cutoutBytes));
  const rect = figma.createRectangle();
  rect.resize(width, height);
  rect.x = x;
  rect.y = y;
  rect.fills = [{ type: 'IMAGE', imageHash: cutoutImage.hash, scaleMode: 'FILL' }];
  rect.name = '분리된 오브젝트';

  const parentNode = originalNode.parent || figma.currentPage;
  parentNode.appendChild(rect);
  figma.currentPage.selection = [rect];
  figma.viewport.scrollAndZoomIntoView([rect]);

  figma.ui.postMessage({ type: 'magic-layer-done' });
}
```

- [ ] **Step 3: 수동 검증**

1. 로컬 서버 실행, Figma에서 플러그인 재실행
2. 이미지 선택 → 매직레이어 → 오브젝트 클릭해 마스크 만들기 → "추출" 클릭

Expected:
- 원래 이미지 레이어의 마스크 영역이 투명하게 뚫림
- 그 자리에 마스크로 잘라낸 오브젝트만 담긴 새 레이어("분리된 오브젝트")가 원본과 정확히 같은 위치/크기로 생성됨
- 새 레이어를 드래그하면 독립적으로 움직여지고, 뒤에 뚫린 배경이 보임

3. 새로 생긴 레이어를 다른 위치로 옮겨서 배경과 완전히 분리되어 있는지 확인
4. 같은 원본 프레임의 다른 이미지에도 반복해서 매직레이어 실행 → 여러 레이어가 정상적으로 쌓이는지 확인

- [ ] **Step 4: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add server/public/ui-app.js code.js
git commit -m "feat: apply magic layer extraction to Figma canvas nodes"
```

---

## Task 10: README 작성 및 전체 검증 체크리스트

**Files:**
- Create: `insta-benchmark-figma-plugin/README.md`

**Interfaces:**
- 없음 (문서 태스크)

- [ ] **Step 1: `README.md` 작성**

```markdown
# 인스타 벤치마킹 피그마 플러그인

인스타그램 게시물 링크를 붙여넣으면 이미지+캡션이 피그마에 자동 정렬되고, 캔버스의 이미지를 클릭 한 번으로 오브젝트 단위 레이어로 분리("매직레이어")할 수 있는 피그마 플러그인입니다. 완전히 로컬에서 동작하며 유료 서비스에 의존하지 않습니다.

## 준비물

- [Node.js](https://nodejs.org/ko) 18 이상
- [Figma 데스크톱 앱](https://www.figma.com/downloads/) (무료)

## 최초 설정 (한 번만)

\`\`\`bash
cd insta-benchmark-figma-plugin
npm install
npm run vendor:sam
\`\`\`

## 실행 방법

1. 터미널에서 로컬 서버 실행 (플러그인 쓰는 동안 계속 켜둬야 함):

\`\`\`bash
npm run server
\`\`\`

2. Figma 데스크톱 앱에서: 아무 파일이나 열기 → `Plugins` → `Development` → `Import plugin from manifest...` → 이 폴더의 `manifest.json` 선택 (최초 1회만)
3. `Plugins` → `Development` → `인스타 벤치마킹` 실행

## 사용법

### 게시물 임포트
1. 공개 인스타그램 게시물 링크를 입력창에 붙여넣고 "가져오기" 클릭
2. 캔버스에 실제 픽셀 크기의 이미지(캐러셀이면 여러 장 가로 배치) + 캡션이 새 프레임으로 생성됨

### 매직레이어 (오브젝트 분리)
1. 캔버스에서 이미지가 있는 레이어를 하나 선택
2. 플러그인의 "선택한 이미지에서 오브젝트 분리" 클릭
3. 편집 화면에서 분리하고 싶은 오브젝트를 클릭 (Shift+클릭 = 마스크에서 제외)
4. "추출" 클릭 → 원본 자리는 투명하게 뚫리고, 분리된 오브젝트가 독립된 레이어로 생성됨

## 알아두면 좋은 점

- 로컬 서버가 꺼져 있으면 두 기능 모두 동작하지 않습니다 (플러그인 UI 자체도 로컬 서버가 서빙합니다)
- SAM 모델은 최초 실행 시 다운로드되고 이후 브라우저 캐시에 저장되어 오프라인에서도 동작합니다
- 인스타그램 페이지 구조가 바뀌면 임포트 파싱이 깨질 수 있습니다 (`server/parse-instagram.js` 참고)
- 개인적인 벤치마킹 용도의 로컬 도구이며, 재배포나 대량 수집 목적이 아닙니다

## 개발자용: 파서 테스트

\`\`\`bash
npm test
\`\`\`
```

- [ ] **Step 2: 최종 통합 검증 체크리스트 실행**

아래 항목을 순서대로 실제로 수행하며 확인한다 (스펙의 "검증 방식" 섹션과 동일):

1. `npm run server` 실행 중, Figma에서 플러그인 실행된 상태에서:
   - [ ] 실제 공개 단일 이미지 게시물 링크 임포트 → 프레임/이미지/캡션 생성 확인
   - [ ] 실제 공개 캐러셀 게시물 링크 임포트 → 이미지 여러 장 가로 배치 확인
   - [ ] 임포트된 이미지에 매직레이어 실행 → 오브젝트 클릭 → 마스크 확인 → 추출 → 새 레이어 독립 이동 확인
2. 로컬 서버를 끈 상태(`Ctrl+C`)에서:
   - [ ] 링크 임포트 시도 → "로컬 서버에 연결할 수 없어요..." 에러 안내 확인
3. 로컬 서버를 다시 켜고:
   - [ ] 삭제되었거나 존재하지 않는 게시물 링크로 임포트 시도 → 명확한 실패 메시지 확인
   - [ ] 아무것도 선택하지 않은 채 매직레이어 버튼 클릭 → "이미지가 있는 레이어를 하나만 선택해주세요." 확인

모든 항목이 통과하면 완료.

- [ ] **Step 3: 커밋**

```bash
cd "/Users/seobongsu/Desktop/클로드/insta-benchmark-figma-plugin"
git add README.md
git commit -m "docs: add README with setup instructions and verification checklist"
```
