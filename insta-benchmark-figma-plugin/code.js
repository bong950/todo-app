figma.showUI(__html__, { width: 420, height: 640 });

figma.on('selectionchange', () => {
  postSelectionState();
});

postSelectionState();

function postSelectionState() {
  const selection = figma.currentPage.selection;
  const node = selection[0];
  const hasImageFill =
    selection.length === 1 && node && 'fills' in node && Array.isArray(node.fills) && node.fills.some((f) => f.type === 'IMAGE');
  figma.ui.postMessage({ type: 'selection-state', hasImageFill });
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
    postSelectionState();
  } else if (msg.type === 'import-post') {
    await handleImportPost(msg);
  } else if (msg.type === 'request-magic-layer') {
    await handleMagicLayerRequest();
  } else if (msg.type === 'apply-magic-layer') {
    await handleApplyMagicLayer(msg);
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
    imageBytes: bytes,
    nodeId: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  });
}

async function handleImportPost({ images, caption, author }) {
  try {
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
    captionText.textAutoResize = 'HEIGHT';
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
  } catch (err) {
    figma.ui.postMessage({ type: 'import-error', message: `임포트 실패: ${err.message}` });
  }
}

async function handleApplyMagicLayer(msg) {
  try {
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
  } catch (err) {
    figma.ui.postMessage({ type: 'magic-layer-error', message: `레이어 분리 실패: ${err.message}` });
  }
}
