export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}
