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
