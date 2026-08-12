import { extname } from 'node:path';
import { UnsupportedInputError } from './input-error.js';

export const supportedImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 20;

export interface ImageInput {
  mimeType: typeof supportedImageTypes[number];
  data: Buffer;
  filename: string;
}

function extensionFor(mimeType: ImageInput['mimeType']): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  return `.${mimeType.slice('image/'.length)}`;
}

function imageUrl(part: Record<string, unknown>): string | undefined {
  const value = part.image_url;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).url === 'string') {
    return (value as Record<string, unknown>).url as string;
  }
  return undefined;
}

export function decodeImagePart(part: unknown, index: number): ImageInput | undefined {
  if (!part || typeof part !== 'object') return undefined;
  const record = part as Record<string, unknown>;
  if (record.type !== 'image_url' && record.type !== 'input_image') return undefined;

  const url = imageUrl(record);
  if (!url) throw new UnsupportedInputError(`Image input ${index} does not contain an image_url`);
  if (!url.startsWith('data:')) {
    throw new UnsupportedInputError('Only base64 data URL image inputs are supported; Kilo sends pasted and dropped images in this format');
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  if (!match) throw new UnsupportedInputError(`Image input ${index} is not a valid base64 data URL`);
  const mimeType = match[1]?.toLowerCase();
  if (!supportedImageTypes.includes(mimeType as ImageInput['mimeType'])) {
    throw new UnsupportedInputError(`Image MIME type '${mimeType}' is not supported; use PNG, JPEG, GIF, or WebP`);
  }

  const encoded = (match[2] ?? '').replace(/\s/g, '');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new UnsupportedInputError(`Image input ${index} contains invalid base64 data`);
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new UnsupportedInputError(`Image input ${index} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
  }

  const requestedName = typeof record.filename === 'string' ? record.filename : `image-${String(index).padStart(2, '0')}`;
  const extension = extensionFor(mimeType as ImageInput['mimeType']);
  const filename = extname(requestedName) ? requestedName : `${requestedName}${extension}`;
  return { mimeType: mimeType as ImageInput['mimeType'], data, filename };
}

export function collectImages(parts: unknown[]): ImageInput[] {
  const images = parts.map((part, index) => decodeImagePart(part, index + 1)).filter((part): part is ImageInput => Boolean(part));
  if (images.length > MAX_IMAGES) throw new UnsupportedInputError(`At most ${MAX_IMAGES} images are supported per request`);
  return images;
}
