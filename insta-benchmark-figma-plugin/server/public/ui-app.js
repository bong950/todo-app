function setStatus(text) {
  document.getElementById('status').textContent = text;
}

const magicLayerBtn = document.getElementById('magic-layer-btn');
magicLayerBtn.disabled = true;

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

parent.postMessage({ pluginMessage: { type: 'ping' } }, '*');

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
