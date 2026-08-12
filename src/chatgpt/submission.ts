export interface SubmissionActions {
  primary(): Promise<void>;
  fallback(): Promise<void>;
  reset(): Promise<void>;
}

function normalizeComposerText(value: string): string {
  // ProseMirror represents pasted line breaks as a mix of text nodes and block
  // elements. innerText can therefore add/remove whitespace while preserving
  // every textual token. Compare the canonical text rather than its DOM layout.
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function composerTextMatches(actual: string, expected: string): boolean {
  return normalizeComposerText(actual) === normalizeComposerText(expected);
}

export function describeComposerMismatch(actual: string, expected: string): string {
  const normalizedActual = normalizeComposerText(actual);
  const normalizedExpected = normalizeComposerText(expected);
  let index = 0;
  while (index < normalizedActual.length && index < normalizedExpected.length
    && normalizedActual[index] === normalizedExpected[index]) index += 1;
  const actualCode = normalizedActual.codePointAt(index);
  const expectedCode = normalizedExpected.codePointAt(index);
  return [
    `normalized expected ${normalizedExpected.length}, got ${normalizedActual.length}`,
    `first difference at ${index}`,
    `expected U+${expectedCode?.toString(16).toUpperCase() ?? 'EOF'}`,
    `got U+${actualCode?.toString(16).toUpperCase() ?? 'EOF'}`,
  ].join('; ');
}

export function splitInsertionText(value: string, chunkCharacters = 2_000): string[] {
  if (!Number.isInteger(chunkCharacters) || chunkCharacters <= 0) {
    throw new Error('chunkCharacters must be a positive integer');
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + chunkCharacters);
    if (end < value.length && value[end - 1] === '\r' && value[end] === '\n') end -= 1;

    const previousCodeUnit = value.charCodeAt(end - 1);
    const nextCodeUnit = value.charCodeAt(end);
    const splitsSurrogatePair = previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff
      && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff;
    if (splitsSurrogatePair) end -= 1;

    // A chunk size of one can land on an indivisible two-code-unit sequence.
    if (end === offset) end = Math.min(value.length, offset + 2);
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export async function submitWithRecovery(actions: SubmissionActions, attempts = 2): Promise<void> {
  const failures: unknown[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await actions.primary();
      return;
    } catch (error) {
      failures.push(error);
    }

    try {
      await actions.fallback();
      return;
    } catch (error) {
      failures.push(error);
    }

    if (attempt + 1 < attempts) await actions.reset();
  }

  const last = failures.at(-1);
  const details = failures.map((failure, index) => {
    const message = failure instanceof Error ? failure.message : String(failure);
    return `strategy ${index + 1}: ${message}`;
  }).join(' | ');
  throw new Error(`ChatGPT composer submission failed after ${attempts} attempts: ${details}`, { cause: last });
}
