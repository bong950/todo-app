figma.showUI(__html__, { width: 420, height: 640 });

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
