import type { ImageInput } from './images.js';

export interface StoredResponse {
  id: string;
  response: Record<string, unknown>;
  inputItems: unknown[];
  contextText: string;
  contextImages: ImageInput[];
  createdAt: number;
}

interface StoredEntry {
  value: StoredResponse;
  imageBytes: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_IMAGE_BYTES = 128 * 1024 * 1024;

function retainedImageBytes(value: StoredResponse): number {
  const seen = new Set<Buffer>();
  let total = 0;
  for (const image of value.contextImages) {
    if (seen.has(image.data)) continue;
    seen.add(image.data);
    total += image.data.byteLength;
  }
  return total;
}

export class ResponseStore {
  private readonly values = new Map<string, StoredEntry>();
  private imageBytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('maxEntries must be a positive integer');
    }
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0) {
      throw new Error('maxImageBytes must be a positive safe integer');
    }
  }

  set(value: StoredResponse): void {
    this.remove(value.id);

    const entry = { value, imageBytes: retainedImageBytes(value) };
    this.values.set(value.id, entry);
    this.imageBytes += entry.imageBytes;

    while (this.values.size > this.maxEntries || this.imageBytes > this.maxImageBytes) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  get(id: string): StoredResponse | undefined {
    return this.values.get(id)?.value;
  }

  delete(id: string): boolean {
    return this.remove(id);
  }

  private remove(id: string): boolean {
    const entry = this.values.get(id);
    if (!entry) return false;
    this.values.delete(id);
    this.imageBytes -= entry.imageBytes;
    return true;
  }
}
