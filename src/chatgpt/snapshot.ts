export class StableSnapshot {
  private value = '';
  private changedAt = 0;

  constructor(private readonly stableForMs: number) {}

  observe(value: string, now = Date.now()): string | undefined {
    const normalized = value.trimEnd();

    if (normalized !== this.value) {
      this.value = normalized;
      this.changedAt = now;
      return undefined;
    }

    if (!normalized || now - this.changedAt < this.stableForMs) return undefined;
    return normalized;
  }
}
