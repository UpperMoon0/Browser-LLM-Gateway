import type { ImageInput } from './images.js';

export interface StoredResponse {
  id: string;
  response: Record<string, unknown>;
  inputItems: unknown[];
  contextText: string;
  contextImages: ImageInput[];
  createdAt: number;
}

export class ResponseStore {
  private readonly values = new Map<string, StoredResponse>();

  constructor(private readonly maxEntries = 200) {}

  set(value: StoredResponse): void {
    this.values.delete(value.id);
    this.values.set(value.id, value);
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) break;
      this.values.delete(oldest);
    }
  }

  get(id: string): StoredResponse | undefined {
    return this.values.get(id);
  }

  delete(id: string): boolean {
    return this.values.delete(id);
  }
}
