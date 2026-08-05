# Premiere Link Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal-use Premiere Pro CEP panel that downloads a pasted YouTube/Instagram/TikTok link via `yt-dlp` and auto-imports the resulting file into a `00_LinkImport` bin in the active project.

**Architecture:** A CEP (Common Extensibility Platform) extension with Node.js integration enabled. Panel JS (`js/main.js`) shells out to the already-installed `yt-dlp`/`ffmpeg` CLIs via `child_process`, then calls an ExtendScript host function (`jsx/hostscript.jsx`) through `CSInterface.evalScript()` to create the bin and import the downloaded file into Premiere's project panel.

**Tech Stack:** CEP 12 (verify exact version at Task 1), vanilla HTML/CSS/JS (no bundler, no framework), Node.js (built into CEP's mixed-context runtime) for `child_process`/`fs`, ExtendScript (JSX) for the Premiere DOM, Node's built-in `node:test` for unit tests.

## Global Constraints

- Personal use only — no licensing, ZXP signing, or installer packaging (spec: "판매/배포 목적이 아니므로 라이선스, 설치 패키징, 서명(ZXP)은 다루지 않는다")
- Downloaded files are saved to `<프로젝트폴더>/00_LinkImport/` (spec §2, confirmed by user)
- Quality format strings are fixed exactly as specified:
  - HD: `bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]`
  - FHD (default): `bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]`
  - 4K: `bv*[height<=2160]+ba/b`
- Supported URL domains only: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`, `instagram.com`, `www.instagram.com`, `tiktok.com`, `www.tiktok.com` (spec §2)
- Target bin name is fixed as `00_LinkImport` (spec §3)
- No automated tests for the ExtendScript/CEP integration layer — verify manually in Premiere Pro 2026 (spec §7)
- Unit tests use Node's built-in `node:test` / `node:assert` — no external test framework dependency (spec §7)
- macOS only; Windows and search/trim/track-auto-insert are out of scope for this plan (spec "범위 밖")
- Project root for this extension: `/Users/seobongsu/Desktop/클로드/premiere-link-import/`

---

## File Structure

```
premiere-link-import/
├── .debug                     # CEP remote-debug port config (dev only)
├── CSXS/manifest.xml          # Extension metadata
├── package.json               # test script only, no deps
├── index.html                 # Panel UI shell
├── css/style.css               # Panel styling
├── js/
│   ├── csinterface-shim.js     # Minimal CSInterface.evalScript wrapper
│   ├── main.js                 # UI wiring, yt-dlp spawn, evalScript calls
│   └── lib/
│       ├── validateUrl.js       # isSupportedUrl(url) -> boolean
│       ├── formatString.js      # getFormatString(quality) -> string
│       ├── parseProgress.js     # parseProgressLine(line) -> number|null
│       └── buildLinkImportDir.js # buildLinkImportDir/buildOutputTemplate
├── jsx/hostscript.jsx          # getProjectFolderPath / importToLinkImportBin
├── tests/
│   ├── validateUrl.test.js
│   ├── formatString.test.js
│   ├── parseProgress.test.js
│   └── buildLinkImportDir.test.js
└── README.md                   # Install + usage instructions
```

Each `js/lib/*.js` file uses a UMD-lite pattern: `module.exports` when loaded via Node's `require` (unit tests), or attached to `window` when loaded via a `<script>` tag in the panel (CEP). `main.js` calls the lib functions as plain globals (they're loaded via `<script>` tags before `main.js` in `index.html`), and uses `require("child_process")` / `require("fs")` directly — CEP's `--mixed-context` flag exposes Node's `require` as a global inside browser-context `<script>`-tag scripts, so no bundler is needed anywhere in this project.

---

### Task 1: CEP extension scaffold

**Files:**
- Create: `premiere-link-import/CSXS/manifest.xml`
- Create: `premiere-link-import/.debug`
- Create: `premiere-link-import/index.html` (placeholder, replaced in Task 6)
- Create: `premiere-link-import/jsx/hostscript.jsx` (empty stub, filled in Task 8)

**Interfaces:**
- Produces: extension bundle ID `com.seobongsu.premiere.linkimport`, extension ID `com.seobongsu.premiere.linkimport.panel`, remote debug port `8088` — later tasks and the README reuse these exact strings.

- [ ] **Step 1: Discover the installed Premiere Pro's CEP runtime version**

Run:
```bash
grep -r 'RequiredRuntime Name="CSXS"' "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Extensions" 2>/dev/null | head -3
```
Expected: one or more lines containing `Version="12.0"` (or whatever version Adobe currently ships). Note the version number — it's used in Step 2 below. If the command returns nothing, run:
```bash
find "/Applications/Adobe Premiere Pro 2026" -iname "manifest.xml" 2>/dev/null | xargs grep -o 'CSXS" Version="[0-9.]*"' 2>/dev/null | sort -u
```
and use whatever version appears most often. Default to `12.0` if neither command finds anything.

- [ ] **Step 2: Create the extension manifest**

Create `premiere-link-import/CSXS/manifest.xml` (replace `12.0` in the two places marked below with the version discovered in Step 1 if it differs):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionManifest Version="12.0" ExtensionBundleId="com.seobongsu.premiere.linkimport" ExtensionBundleVersion="1.0.0" ExtensionBundleName="Premiere Link Import" xmlns:ExtensionManifest="http://ns.adobe.com/CSMExtension/12.0">
  <ExtensionList>
    <Extension Id="com.seobongsu.premiere.linkimport.panel" Version="1.0.0" />
  </ExtensionList>
  <ExecutionEnvironment>
    <HostList>
      <Host Name="PPRO" Version="[0.0,99.9]" />
    </HostList>
    <LocaleList>
      <Locale Code="All" />
    </LocaleList>
    <RequiredRuntimeList>
      <RequiredRuntime Name="CSXS" Version="12.0" />
    </RequiredRuntimeList>
  </ExecutionEnvironment>
  <DispatchInfoList>
    <Extension Id="com.seobongsu.premiere.linkimport.panel">
      <DispatchInfo>
        <Resources>
          <MainPath>./index.html</MainPath>
          <ScriptPath>./jsx/hostscript.jsx</ScriptPath>
          <CEFCommandLine>
            <Parameter>--enable-nodejs</Parameter>
            <Parameter>--mixed-context</Parameter>
          </CEFCommandLine>
        </Resources>
        <Lifecycle>
          <AutoVisible>true</AutoVisible>
        </Lifecycle>
        <UI>
          <Type>Panel</Type>
          <Menu>Link Import</Menu>
          <Geometry>
            <Size>
              <Height>500</Height>
              <Width>320</Width>
            </Size>
            <MinSize>
              <Height>300</Height>
              <Width>280</Width>
            </MinSize>
          </Geometry>
        </UI>
      </DispatchInfo>
    </Extension>
  </DispatchInfoList>
</ExtensionManifest>
```

- [ ] **Step 3: Create the remote-debug config**

Create `premiere-link-import/.debug`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.seobongsu.premiere.linkimport.panel">
    <HostList>
      <Host Name="PPRO" Port="8088"/>
    </HostList>
  </Extension>
</ExtensionList>
```

This lets you open `http://localhost:8088` in Chrome during development to attach DevTools to the panel (console, network, breakpoints) — CEP panels have no other debugging surface.

- [ ] **Step 4: Create placeholder index.html and empty hostscript.jsx**

Create `premiere-link-import/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Link Import</title>
</head>
<body>
  <p>Link Import loading...</p>
</body>
</html>
```

Create `premiere-link-import/jsx/hostscript.jsx`:

```javascript
// Filled in Task 8: getProjectFolderPath, importToLinkImportBin
```

- [ ] **Step 5: Enable CEP debug mode and install the extension**

Run:
```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions
ln -s "/Users/seobongsu/Desktop/클로드/premiere-link-import" ~/Library/Application\ Support/Adobe/CEP/extensions/premiere-link-import
```
Replace `com.adobe.CSXS.12` with `com.adobe.CSXS.<version>` using the version found in Step 1 if different. The symlink (rather than a copy) means later file edits are picked up without reinstalling.

- [ ] **Step 6: Manually verify the panel loads**

Quit and reopen Adobe Premiere Pro 2026. Go to Window → Extensions → Link Import. Expected: a panel opens showing the text "Link Import loading...". If the menu item is missing, re-check Step 5 (debug mode key must match the app's actual CSXS version) and confirm the symlink target path has no typos.

- [ ] **Step 7: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/CSXS/manifest.xml premiere-link-import/.debug premiere-link-import/index.html premiere-link-import/jsx/hostscript.jsx
git commit -m "feat: scaffold Premiere Link Import CEP extension"
```

---

### Task 2: URL validation (`validateUrl.js`)

**Files:**
- Create: `premiere-link-import/package.json`
- Create: `premiere-link-import/js/lib/validateUrl.js`
- Test: `premiere-link-import/tests/validateUrl.test.js`

**Interfaces:**
- Produces: `isSupportedUrl(rawUrl: string): boolean` — used by `main.js` (Task 9) as a global `window.isSupportedUrl` in the panel, and via `require(...)` in tests.

- [ ] **Step 1: Create package.json**

Create `premiere-link-import/package.json`:

```json
{
  "name": "premiere-link-import",
  "version": "1.0.0",
  "private": true,
  "description": "Premiere Pro CEP panel: download a video link and import it into the active project",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `premiere-link-import/tests/validateUrl.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert");
const { isSupportedUrl } = require("../js/lib/validateUrl.js");

test("accepts a standard youtube watch URL", () => {
  assert.strictEqual(isSupportedUrl("https://www.youtube.com/watch?v=abc123"), true);
});

test("accepts a youtu.be short URL", () => {
  assert.strictEqual(isSupportedUrl("https://youtu.be/abc123"), true);
});

test("accepts an instagram reel URL", () => {
  assert.strictEqual(isSupportedUrl("https://www.instagram.com/reel/abc123/"), true);
});

test("accepts a tiktok URL", () => {
  assert.strictEqual(isSupportedUrl("https://www.tiktok.com/@user/video/123"), true);
});

test("rejects an unsupported domain", () => {
  assert.strictEqual(isSupportedUrl("https://vimeo.com/12345"), false);
});

test("rejects an empty string", () => {
  assert.strictEqual(isSupportedUrl(""), false);
});

test("rejects a malformed URL", () => {
  assert.strictEqual(isSupportedUrl("not a url"), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "/Users/seobongsu/Desktop/클로드/premiere-link-import" && npm test`
Expected: FAIL — `Cannot find module '../js/lib/validateUrl.js'`

- [ ] **Step 4: Write minimal implementation**

Create `premiere-link-import/js/lib/validateUrl.js`:

```javascript
const SUPPORTED_HOSTNAMES = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com"
];

function isSupportedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  return SUPPORTED_HOSTNAMES.indexOf(parsed.hostname) !== -1;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isSupportedUrl };
} else {
  window.isSupportedUrl = isSupportedUrl;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests passing, 0 failing

- [ ] **Step 6: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/package.json premiere-link-import/js/lib/validateUrl.js premiere-link-import/tests/validateUrl.test.js
git commit -m "feat: add URL validation for supported link domains"
```

---

### Task 3: Quality format strings (`formatString.js`)

**Files:**
- Create: `premiere-link-import/js/lib/formatString.js`
- Test: `premiere-link-import/tests/formatString.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getFormatString(quality: "HD"|"FHD"|"4K"): string` — used by `main.js` (Task 9) as `window.getFormatString`.

- [ ] **Step 1: Write the failing test**

Create `premiere-link-import/tests/formatString.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert");
const { getFormatString } = require("../js/lib/formatString.js");

test("HD returns the 720p format string", () => {
  assert.strictEqual(getFormatString("HD"), "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]");
});

test("FHD returns the 1080p format string", () => {
  assert.strictEqual(getFormatString("FHD"), "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]");
});

test("4K returns the 2160p format string", () => {
  assert.strictEqual(getFormatString("4K"), "bv*[height<=2160]+ba/b");
});

test("throws on an unsupported quality value", () => {
  assert.throws(() => getFormatString("8K"), /Unsupported quality: 8K/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/lib/formatString.js'`

- [ ] **Step 3: Write minimal implementation**

Create `premiere-link-import/js/lib/formatString.js`:

```javascript
const QUALITY_FORMATS = {
  HD: "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
  FHD: "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
  "4K": "bv*[height<=2160]+ba/b"
};

function getFormatString(quality) {
  const format = QUALITY_FORMATS[quality];
  if (!format) {
    throw new Error("Unsupported quality: " + quality);
  }
  return format;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getFormatString };
} else {
  window.getFormatString = getFormatString;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 11 tests passing total (7 from Task 2 + 4 here), 0 failing

- [ ] **Step 5: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/js/lib/formatString.js premiere-link-import/tests/formatString.test.js
git commit -m "feat: add yt-dlp quality format string lookup"
```

---

### Task 4: Progress line parsing (`parseProgress.js`)

**Files:**
- Create: `premiere-link-import/js/lib/parseProgress.js`
- Test: `premiere-link-import/tests/parseProgress.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseProgressLine(line: string): number|null` — used by `main.js` (Task 9) as `window.parseProgressLine` to update the status text while `yt-dlp` runs.

- [ ] **Step 1: Write the failing test**

Create `premiere-link-import/tests/parseProgress.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert");
const { parseProgressLine } = require("../js/lib/parseProgress.js");

test("parses a mid-download percentage", () => {
  assert.strictEqual(parseProgressLine("[download]  12.3% of   50.00MiB at    1.00MiB/s ETA 00:40"), 12.3);
});

test("parses a whole-number percentage", () => {
  assert.strictEqual(parseProgressLine("[download] 100% of 50.00MiB in 00:05"), 100);
});

test("returns null for a non-progress line", () => {
  assert.strictEqual(parseProgressLine("[Merger] Merging formats into \"video.mp4\""), null);
});

test("returns null for an empty line", () => {
  assert.strictEqual(parseProgressLine(""), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/lib/parseProgress.js'`

- [ ] **Step 3: Write minimal implementation**

Create `premiere-link-import/js/lib/parseProgress.js`:

```javascript
const PROGRESS_PATTERN = /\[download\]\s+([\d.]+)%/;

function parseProgressLine(line) {
  const match = PROGRESS_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  return parseFloat(match[1]);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseProgressLine };
} else {
  window.parseProgressLine = parseProgressLine;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 15 tests passing total, 0 failing

- [ ] **Step 5: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/js/lib/parseProgress.js premiere-link-import/tests/parseProgress.test.js
git commit -m "feat: add yt-dlp progress line parser"
```

---

### Task 5: Output path helpers (`buildLinkImportDir.js`)

**Files:**
- Create: `premiere-link-import/js/lib/buildLinkImportDir.js`
- Test: `premiere-link-import/tests/buildLinkImportDir.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildLinkImportDir(projectFolderPath: string): string` and `buildOutputTemplate(projectFolderPath: string): string` — used by `main.js` (Task 9) as `window.buildLinkImportDir` / `window.buildOutputTemplate`.

- [ ] **Step 1: Write the failing test**

Create `premiere-link-import/tests/buildLinkImportDir.test.js`:

```javascript
const { test } = require("node:test");
const assert = require("node:assert");
const { buildLinkImportDir, buildOutputTemplate } = require("../js/lib/buildLinkImportDir.js");

test("builds the 00_LinkImport subdirectory path", () => {
  assert.strictEqual(
    buildLinkImportDir("/Users/x/Projects/MyProj"),
    "/Users/x/Projects/MyProj/00_LinkImport"
  );
});

test("builds the yt-dlp output template", () => {
  assert.strictEqual(
    buildOutputTemplate("/Users/x/Projects/MyProj"),
    "/Users/x/Projects/MyProj/00_LinkImport/%(title)s.%(ext)s"
  );
});

test("buildLinkImportDir throws on an empty project folder path", () => {
  assert.throws(() => buildLinkImportDir(""), /projectFolderPath is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/lib/buildLinkImportDir.js'`

- [ ] **Step 3: Write minimal implementation**

Create `premiere-link-import/js/lib/buildLinkImportDir.js`:

```javascript
const path = require("node:path");

function buildLinkImportDir(projectFolderPath) {
  if (!projectFolderPath) {
    throw new Error("projectFolderPath is required");
  }
  return path.join(projectFolderPath, "00_LinkImport");
}

function buildOutputTemplate(projectFolderPath) {
  return path.join(buildLinkImportDir(projectFolderPath), "%(title)s.%(ext)s");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildLinkImportDir, buildOutputTemplate };
} else {
  window.buildLinkImportDir = buildLinkImportDir;
  window.buildOutputTemplate = buildOutputTemplate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 18 tests passing total, 0 failing

- [ ] **Step 5: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/js/lib/buildLinkImportDir.js premiere-link-import/tests/buildLinkImportDir.test.js
git commit -m "feat: add download output path helpers"
```

---

### Task 6: Panel UI markup and styling

**Files:**
- Modify: `premiere-link-import/index.html` (replace placeholder body)
- Create: `premiere-link-import/css/style.css`

**Interfaces:**
- Produces: DOM elements consumed by `main.js` (Task 9) — element IDs `url-input`, `quality-select`, `import-btn`, `status-text`, `recent-list` must match exactly.

- [ ] **Step 1: Replace index.html with the full panel markup**

Modify `premiere-link-import/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Link Import</title>
  <link rel="stylesheet" href="css/style.css" />
</head>
<body>
  <main>
    <h1>Link Import</h1>

    <label for="url-input">링크</label>
    <input type="text" id="url-input" placeholder="https://www.youtube.com/watch?v=..." />

    <label for="quality-select">화질</label>
    <select id="quality-select">
      <option value="HD">HD (720p)</option>
      <option value="FHD" selected>FHD (1080p)</option>
      <option value="4K">4K (2160p)</option>
    </select>

    <button id="import-btn">가져오기</button>

    <p id="status-text"></p>

    <h2>최근 가져온 항목</h2>
    <ul id="recent-list"></ul>
  </main>
</body>
</html>
```

- [ ] **Step 2: Create the stylesheet**

Create `premiere-link-import/css/style.css`:

```css
body {
  margin: 0;
  padding: 16px;
  background: #1e1e1e;
  color: #e0e0e0;
  font-family: -apple-system, "Segoe UI", sans-serif;
  font-size: 12px;
}

h1 {
  font-size: 15px;
  margin: 0 0 12px;
}

h2 {
  font-size: 12px;
  color: #aaa;
  margin: 20px 0 8px;
}

label {
  display: block;
  margin-bottom: 4px;
  color: #aaa;
}

input, select, button {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  margin-bottom: 12px;
  background: #2d2d2d;
  color: #e0e0e0;
  border: 1px solid #444;
  border-radius: 3px;
  font-size: 12px;
}

button {
  background: #0e63e0;
  border: none;
  cursor: pointer;
  font-weight: 600;
}

button:disabled {
  background: #444;
  cursor: default;
}

#status-text {
  min-height: 16px;
  color: #8ecdf8;
}

#recent-list {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 11px;
  color: #999;
}

#recent-list li {
  padding: 4px 0;
  border-bottom: 1px solid #333;
}
```

- [ ] **Step 3: Verify the layout visually**

Open `premiere-link-import/index.html` directly in a browser tab (`file://` URL) and confirm: title input, quality dropdown (FHD selected by default), "가져오기" button, empty status line, and "최근 가져온 항목" heading all render with the dark theme applied. Take a screenshot to confirm.

- [ ] **Step 4: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/index.html premiere-link-import/css/style.css
git commit -m "feat: build panel UI markup and dark theme styling"
```

---

### Task 7: CSInterface shim

**Files:**
- Create: `premiere-link-import/js/csinterface-shim.js`
- Modify: `premiere-link-import/index.html` (add script tag)

**Interfaces:**
- Produces: `window.CSInterface` class with `evalScript(script: string, callback?: (result: string) => void)` — used by `main.js` (Task 9).

- [ ] **Step 1: Create the shim**

Create `premiere-link-import/js/csinterface-shim.js`:

```javascript
(function (global) {
  function CSInterface() {}

  CSInterface.prototype.evalScript = function (script, callback) {
    if (!global.__adobe_cep__) {
      if (callback) callback("ERROR:NO_ADOBE_CEP_BRIDGE");
      return;
    }
    global.__adobe_cep__.evalScript(script, callback || function () {});
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CSInterface;
  } else {
    global.CSInterface = CSInterface;
  }
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 2: Wire it into index.html**

Modify `premiere-link-import/index.html`, adding this line right before `</body>`:

```html
  <script src="js/csinterface-shim.js"></script>
</body>
```

- [ ] **Step 3: Verify outside Premiere**

Open `premiere-link-import/index.html` in a plain Chrome tab, open DevTools console, and run:
```javascript
new CSInterface().evalScript("test", (result) => console.log(result))
```
Expected output: `ERROR:NO_ADOBE_CEP_BRIDGE` (proves the shim loaded and falls back gracefully when `window.__adobe_cep__` isn't present, i.e. outside a CEP host).

- [ ] **Step 4: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/js/csinterface-shim.js premiere-link-import/index.html
git commit -m "feat: add minimal CSInterface.evalScript shim"
```

---

### Task 8: ExtendScript host functions

**Files:**
- Modify: `premiere-link-import/jsx/hostscript.jsx` (replace empty stub)

**Interfaces:**
- Produces: `getProjectFolderPath(): string` and `importToLinkImportBin(filePath: string): string` (returns `"OK"`, `"IMPORT_FAILED"`, or `"ERROR:<message>"`) — called from `main.js` (Task 9) via `CSInterface.evalScript()`.

- [ ] **Step 1: Write the host functions**

Modify `premiere-link-import/jsx/hostscript.jsx`:

```javascript
function getProjectFolderPath() {
    if (!app.project || !app.project.path) {
        return "";
    }
    var projectFile = new File(app.project.path);
    return projectFile.parent.fsName;
}

function importToLinkImportBin(filePath) {
    try {
        var binName = "00_LinkImport";
        var rootItem = app.project.rootItem;
        var targetBin = null;

        for (var i = 0; i < rootItem.children.numItems; i++) {
            var child = rootItem.children[i];
            if (child.type === ProjectItemType.BIN && child.name === binName) {
                targetBin = child;
                break;
            }
        }

        if (targetBin === null) {
            targetBin = rootItem.createBin(binName);
        }

        var success = app.project.importFiles([filePath], false, targetBin, false);
        return success ? "OK" : "IMPORT_FAILED";
    } catch (e) {
        return "ERROR:" + e.toString();
    }
}
```

- [ ] **Step 2: Manually verify in Premiere via remote debug console**

With Premiere Pro 2026 running, the Link Import panel open, and a project saved to disk, open Chrome and navigate to `http://localhost:8088`. Click the entry for the panel to open a DevTools window attached to it. In its Console tab, run:
```javascript
window.__adobe_cep__.evalScript('getProjectFolderPath()', console.log)
```
Expected: logs the absolute path to the folder containing the open `.prproj` file.

Then, with any existing video file's absolute path (e.g. an existing footage file already used in a test project), run:
```javascript
window.__adobe_cep__.evalScript('importToLinkImportBin("/absolute/path/to/some-video.mp4")', console.log)
```
Expected: logs `"OK"`, and a new bin named `00_LinkImport` appears in Premiere's Project panel containing the imported clip. Running the same command again with a different file should reuse the existing bin rather than creating a second one.

- [ ] **Step 3: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/jsx/hostscript.jsx
git commit -m "feat: add ExtendScript bin creation and import functions"
```

---

### Task 9: Wire up the full download-and-import flow

**Files:**
- Create: `premiere-link-import/js/main.js`
- Modify: `premiere-link-import/index.html` (add remaining script tags)

**Interfaces:**
- Consumes: `isSupportedUrl` (Task 2), `getFormatString` (Task 3), `parseProgressLine` (Task 4), `buildLinkImportDir`/`buildOutputTemplate` (Task 5), `CSInterface` (Task 7), `getProjectFolderPath`/`importToLinkImportBin` (Task 8) — all as globals already loaded by the time `main.js` runs.
- Produces: the working end-to-end feature. Nothing downstream depends on this file's internals.

- [ ] **Step 1: Add the remaining script tags to index.html**

Modify `premiere-link-import/index.html`, replacing the single script tag added in Task 7 with the full load order (must stay in this order — each file depends on globals from the ones before it):

```html
  <script src="js/csinterface-shim.js"></script>
  <script src="js/lib/validateUrl.js"></script>
  <script src="js/lib/formatString.js"></script>
  <script src="js/lib/parseProgress.js"></script>
  <script src="js/lib/buildLinkImportDir.js"></script>
  <script src="js/main.js"></script>
</body>
```

- [ ] **Step 2: Write main.js**

Create `premiere-link-import/js/main.js`:

```javascript
(function () {
  const { spawn, spawnSync } = require("child_process");
  const fs = require("fs");

  const csInterface = new CSInterface();

  const urlInput = document.getElementById("url-input");
  const qualitySelect = document.getElementById("quality-select");
  const importBtn = document.getElementById("import-btn");
  const statusText = document.getElementById("status-text");
  const recentList = document.getElementById("recent-list");

  function setStatus(message) {
    statusText.textContent = message;
  }

  function checkDependenciesOnLoad() {
    const missing = [];
    if (spawnSync("which", ["yt-dlp"]).status !== 0) missing.push("yt-dlp");
    if (spawnSync("which", ["ffmpeg"]).status !== 0) missing.push("ffmpeg");
    if (missing.length > 0) {
      setStatus(missing.join(", ") + " 설치가 필요해요 (brew install " + missing.join(" ") + ")");
      importBtn.disabled = true;
    }
  }

  function getProjectFolderPath() {
    return new Promise((resolve) => {
      csInterface.evalScript("getProjectFolderPath()", resolve);
    });
  }

  function importToBin(filePath) {
    return new Promise((resolve) => {
      const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      csInterface.evalScript('importToLinkImportBin("' + escapedPath + '")', resolve);
    });
  }

  function addRecentItem(fileName) {
    const li = document.createElement("li");
    li.textContent = fileName + " — " + new Date().toLocaleTimeString();
    recentList.prepend(li);
  }

  importBtn.addEventListener("click", async function () {
    const url = urlInput.value.trim();
    const quality = qualitySelect.value;

    if (!isSupportedUrl(url)) {
      setStatus("지원하지 않는 링크예요 (YouTube/Instagram/TikTok만 가능)");
      return;
    }

    importBtn.disabled = true;
    setStatus("프로젝트 경로 확인 중...");

    const projectFolderPath = await getProjectFolderPath();
    if (!projectFolderPath) {
      setStatus("프로젝트를 먼저 저장해주세요");
      importBtn.disabled = false;
      return;
    }

    const linkImportDir = buildLinkImportDir(projectFolderPath);
    fs.mkdirSync(linkImportDir, { recursive: true });

    const outputTemplate = buildOutputTemplate(projectFolderPath);
    const formatString = getFormatString(quality);

    setStatus("다운로드 중... 0%");

    const args = [
      "-f", formatString,
      "--merge-output-format", "mp4",
      "--restrict-filenames",
      "--newline",
      "--print", "after_move:%(filepath)s",
      "-o", outputTemplate,
      url
    ];

    const ytdlp = spawn("yt-dlp", args);
    let downloadedFilePath = "";

    ytdlp.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      lines.forEach((line) => {
        const progress = parseProgressLine(line);
        if (progress !== null) {
          setStatus("다운로드 중... " + progress + "%");
        } else if (line.trim() && !line.startsWith("[")) {
          downloadedFilePath = line.trim();
        }
      });
    });

    let stderrOutput = "";
    ytdlp.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    ytdlp.on("close", async (code) => {
      if (code !== 0) {
        setStatus("다운로드 실패: " + stderrOutput.slice(-200));
        importBtn.disabled = false;
        return;
      }

      if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
        setStatus("다운로드는 됐지만 파일 경로를 찾을 수 없어요");
        importBtn.disabled = false;
        return;
      }

      setStatus("Premiere로 임포트 중...");
      const result = await importToBin(downloadedFilePath);

      if (result === "OK") {
        setStatus("임포트 완료!");
        addRecentItem(downloadedFilePath.split("/").pop());
        urlInput.value = "";
      } else {
        setStatus("임포트 실패: " + result);
      }

      importBtn.disabled = false;
    });
  });

  checkDependenciesOnLoad();
})();
```

- [ ] **Step 3: Manually verify the full end-to-end flow**

With the Link Import panel open in Premiere Pro 2026 and a saved project: paste a real, short YouTube URL into the URL field, leave quality on FHD, click "가져오기". Expected sequence in the status line: "프로젝트 경로 확인 중..." → "다운로드 중... N%" (increasing) → "Premiere로 임포트 중..." → "임포트 완료!". Confirm in Finder that `<project folder>/00_LinkImport/<title>.mp4` exists, and in Premiere's Project panel that a `00_LinkImport` bin now contains that clip. Also verify the error paths: an unsupported URL (e.g. a vimeo.com link) shows the "지원하지 않는 링크예요" message without spawning any process.

- [ ] **Step 4: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/js/main.js premiere-link-import/index.html
git commit -m "feat: wire up download-and-import flow in the panel"
```

---

### Task 10: Install and usage documentation

**Files:**
- Create: `premiere-link-import/README.md`

**Interfaces:**
- Consumes: nothing (documentation only).

- [ ] **Step 1: Write the README**

Create `premiere-link-import/README.md`:

```markdown
# Premiere Link Import

개인 편집용 Premiere Pro 패널. YouTube/Instagram/TikTok 링크를 붙여넣으면 `yt-dlp`로 다운로드해서
프로젝트 폴더의 `00_LinkImport/`에 저장하고, Premiere 프로젝트 패널의 `00_LinkImport` 빈(bin)에
자동으로 임포트합니다.

## 요구 사항

- macOS
- Adobe Premiere Pro 2026 (다른 버전이면 `CSXS/manifest.xml`의 `RequiredRuntime` 버전 확인 필요)
- `yt-dlp`, `ffmpeg` (Homebrew로 설치: `brew install yt-dlp ffmpeg`)

## 설치

1. 이 폴더(`premiere-link-import/`)를 원하는 위치에 둡니다 (옮기려면 심볼릭 링크를 다시 만들어야 합니다).
2. CEP 디버그 모드 활성화 (설치된 Premiere의 CSXS 버전에 맞게 숫자 교체):
   ```bash
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1
   ```
3. 확장 폴더를 CEP extensions 디렉터리에 심볼릭 링크:
   ```bash
   mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions
   ln -s "$(pwd)/premiere-link-import" ~/Library/Application\ Support/Adobe/CEP/extensions/premiere-link-import
   ```
4. Premiere Pro를 재시작하고 창(Window) → 확장명(Extensions) → Link Import를 엽니다.

## 사용법

1. Premiere 프로젝트를 먼저 저장해둡니다 (저장 안 된 프로젝트는 다운로드 위치를 알 수 없어 임포트가 막힙니다).
2. 패널의 링크 입력창에 YouTube/Instagram/TikTok URL을 붙여넣습니다.
3. 화질(HD/FHD/4K)을 선택합니다 (기본값 FHD).
4. "가져오기"를 클릭합니다. 다운로드 진행률이 표시되고, 완료되면 프로젝트 패널의
   `00_LinkImport` 빈에 클립이 나타납니다.

## 디버깅

패널 자체의 콘솔/에러를 보려면 Chrome에서 `http://localhost:8088`을 열어 DevTools를 붙입니다.

## 범위 밖 (다음 버전 후보)

- 패널 내 유튜브 검색
- I/O 구간 지정 후 부분 다운로드
- 플레이헤드 위치의 트랙에 자동 삽입
- Windows 지원
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/seobongsu/Desktop/클로드"
git add premiere-link-import/README.md
git commit -m "docs: add install and usage instructions"
```
