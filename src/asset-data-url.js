const UPLOADABLE_URL_PATTERN = /^(https:\/\/|data:image\/)/i;

export const toUploadableUrl = async (url, {fetchImpl = fetch, maxBytes = 4_500_000} = {}) => {
  if (typeof url !== 'string' || !url) return null;
  if (UPLOADABLE_URL_PATTERN.test(url)) return url;
  if (!url.startsWith('blob:')) return null;
  const response = await fetchImpl(url);
  const blob = await response.blob();
  if (blob.size > maxBytes) {
    throw new Error(`Image is too large to send inline (${blob.size} bytes, cap ${maxBytes}).`);
  }
  const mimeType = blob.type || 'image/png';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const base64 = (globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64')))(binary);
  return `data:${mimeType};base64,${base64}`;
};
