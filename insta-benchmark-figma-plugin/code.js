figma.showUI(__html__, { width: 420, height: 640 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
  }
};
