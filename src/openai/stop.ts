export class StopFilter {
  private pending = '';
  private stopped = false;
  private readonly stops: string[];
  private readonly keepTail: number;

  constructor(stop?: string | string[]) {
    this.stops = (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(Boolean);
    this.keepTail = Math.max(0, ...this.stops.map((value) => value.length - 1));
  }

  push(delta: string): { text: string; stopped: boolean } {
    if (this.stopped) return { text: '', stopped: true };
    if (!this.stops.length) return { text: delta, stopped: false };

    this.pending += delta;
    let earliest = -1;
    for (const stop of this.stops) {
      const index = this.pending.indexOf(stop);
      if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index;
    }

    if (earliest >= 0) {
      const text = this.pending.slice(0, earliest);
      this.pending = '';
      this.stopped = true;
      return { text, stopped: true };
    }

    if (this.pending.length <= this.keepTail) return { text: '', stopped: false };
    const emitLength = this.pending.length - this.keepTail;
    const text = this.pending.slice(0, emitLength);
    this.pending = this.pending.slice(emitLength);
    return { text, stopped: false };
  }

  flush(): string {
    if (this.stopped) return '';
    const text = this.pending;
    this.pending = '';
    return text;
  }
}
