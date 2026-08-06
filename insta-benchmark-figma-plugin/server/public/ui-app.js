function setStatus(text) {
  document.getElementById('status').textContent = text;
}

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'pong') {
    setStatus('code.js와 통신 확인됨');
  } else if (msg.type === 'import-done') {
    setStatus('임포트 완료!');
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
