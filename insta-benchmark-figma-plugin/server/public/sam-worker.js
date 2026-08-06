import { env, SamModel, AutoProcessor, RawImage, Tensor } from 'http://localhost:3457/lib/transformers.min.js';

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
