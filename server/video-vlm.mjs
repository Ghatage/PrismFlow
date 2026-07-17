export const LOCAL_VIDEO_VLM_MODEL = 'Xenova/moondream2';

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const dataUrlToBlob = (value) => {
  const match = typeof value === 'string' && value.match(/^data:([^;,]+)?;base64,(.+)$/s);
  if (!match) throw new Error('Video frame annotation requires a base64 image data URL.');
  return new Blob([Buffer.from(match[2], 'base64')], {type: match[1] || 'image/jpeg'});
};

const defaultLoadModel = async (modelId) => {
  const {
    AutoProcessor,
    AutoTokenizer,
    Moondream1ForConditionalGeneration,
  } = await import('@huggingface/transformers');
  const processor = await AutoProcessor.from_pretrained(modelId);
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await Moondream1ForConditionalGeneration.from_pretrained(modelId, {
    device: 'cpu',
    dtype: {
      embed_tokens: 'q4',
      vision_encoder: 'q4',
      decoder_model_merged: 'q4',
    },
  });
  return {processor, tokenizer, model, RawImage: (await import('@huggingface/transformers')).RawImage};
};

export const createLocalVideoVlmAdapter = ({
  modelId = LOCAL_VIDEO_VLM_MODEL,
  loadModel = defaultLoadModel,
} = {}) => {
  let modelPromise = null;
  const getModel = () => {
    modelPromise ||= loadModel(modelId);
    return modelPromise;
  };

  const annotateFrame = async ({imageDataUrl, prompt}) => {
    const {processor, tokenizer, model, RawImage} = await getModel();
    const image = await RawImage.fromBlob(dataUrlToBlob(imageDataUrl));
    const visionInputs = await processor(image);
    // Transformers.js exposes Moondream's image features as a fixed patch grid,
    // while the tokenizer expects one <image> placeholder per patch.
    const pixelDims = visionInputs.pixel_values?.dims || [];
    const patchSize = 14;
    const imageTokenCount = pixelDims.length >= 4
      ? Math.max(1, Math.floor(pixelDims.at(-1) / patchSize) * Math.floor(pixelDims.at(-2) / patchSize))
      : 729;
    const text = `${'<image>'.repeat(imageTokenCount)}\n\nQuestion: ${clean(prompt) || 'Describe this image.'}\n\nAnswer:`;
    const textInputs = tokenizer(text);
    const output = await model.generate({
      ...textInputs,
      ...visionInputs,
      do_sample: false,
      max_new_tokens: 96,
    });
    const decoded = tokenizer.batch_decode(output, {skip_special_tokens: false})[0] || '';
    const answer = clean(decoded.split('Answer:').at(-1)?.replace('<|endoftext|>', ''));
    return {annotation: answer || clean(decoded), modelId, provider: 'local-vlm'};
  };

  return {
    modelId,
    warm: async () => { await getModel(); return {modelId, ready: true}; },
    annotateFrame,
    status: () => ({modelId, ready: Boolean(modelPromise)}),
  };
};
