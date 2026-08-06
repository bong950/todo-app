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
