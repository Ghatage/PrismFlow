import {createLocalVideoVlmAdapter} from '../server/video-vlm.mjs';

const adapter = createLocalVideoVlmAdapter();
console.log(`Downloading/loading local video VLM ${adapter.modelId}...`);
await adapter.warm();
console.log(`Local video VLM ready: ${adapter.modelId}`);
