export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedInputError';
  }
}
