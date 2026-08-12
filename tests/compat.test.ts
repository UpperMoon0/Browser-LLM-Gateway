import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeJsonText, parseControlledOutput } from '../src/openai/output.ts';
import { StopFilter } from '../src/openai/stop.ts';
import { withGenerationContract } from '../src/openai/prompt.ts';
import { StableSnapshot } from '../src/chatgpt/snapshot.ts';
import {
  composerTextMatches,
  describeComposerMismatch,
  splitInsertionText,
  submitWithRecovery,
} from '../src/chatgpt/submission.ts';

test('composer text verification tolerates browser newline and non-breaking-space normalization', () => {
  assert.equal(composerTextMatches('hello\r\nDa\u00a0Nang\n', 'hello\nDa Nang'), true);
  assert.equal(composerTextMatches('one\n\n\n two\tthree', 'one\ntwo three'), true);
  assert.equal(composerTextMatches('old prompt', 'new prompt'), false);
  assert.equal(composerTextMatches('call tool_a', 'call tool_b'), false);
});

test('composer mismatch diagnostics reveal positions and code points without content', () => {
  assert.equal(
    describeComposerMismatch('secret-a', 'secret-b'),
    'normalized expected 8, got 8; first difference at 7; expected U+62; got U+61',
  );
});

test('large composer input is split into bounded chunks without changing the text', () => {
  const input = '0123456789'.repeat(1_001);
  const chunks = splitInsertionText(input, 2_000);

  assert.equal(chunks.join(''), input);
  assert.equal(chunks.every((chunk) => chunk.length <= 2_000), true);
  assert.equal(chunks.length, 6);
});

test('composer chunks do not split CRLF sequences or surrogate pairs', () => {
  const input = `abc\r\ndef${String.fromCodePoint(0x1f680)}ghi`;
  const chunks = splitInsertionText(input, 4);

  assert.equal(chunks.join(''), input);
  assert.equal(chunks.some((chunk, index) => chunk.endsWith('\r') && chunks[index + 1]?.startsWith('\n')), false);
  assert.equal(chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk)), false);
  assert.equal(chunks.some((chunk) => /^[\uDC00-\uDFFF]/.test(chunk)), false);
});

test('composer submission uses the fallback when the primary strategy fails', async () => {
  const calls: string[] = [];

  await submitWithRecovery({
    primary: async () => { calls.push('primary'); throw new Error('not editable'); },
    fallback: async () => { calls.push('fallback'); },
    reset: async () => { calls.push('reset'); },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('composer submission reloads and retries when both strategies fail once', async () => {
  const calls: string[] = [];
  let attempt = 0;

  await submitWithRecovery({
    primary: async () => {
      calls.push(`primary-${attempt}`);
      if (attempt === 0) throw new Error('not editable');
    },
    fallback: async () => { calls.push(`fallback-${attempt}`); throw new Error('insertion failed'); },
    reset: async () => { calls.push('reset'); attempt += 1; },
  });

  assert.deepEqual(calls, ['primary-0', 'fallback-0', 'reset', 'primary-1']);
});

test('StableSnapshot returns the final replacement instead of a transient status', () => {
  const snapshot = new StableSnapshot(3_000);

  assert.equal(snapshot.observe('Thinking', 0), undefined);
  assert.equal(snapshot.observe('COBALT-731', 100), undefined);
  assert.equal(snapshot.observe('COBALT-731', 3_099), undefined);
  assert.equal(snapshot.observe('COBALT-731', 3_100), 'COBALT-731');
});

test('StableSnapshot resets its timer whenever generated content changes', () => {
  const snapshot = new StableSnapshot(3_000);

  assert.equal(snapshot.observe('COBALT', 0), undefined);
  assert.equal(snapshot.observe('COBALT-731', 2_000), undefined);
  assert.equal(snapshot.observe('COBALT-731', 4_999), undefined);
  assert.equal(snapshot.observe('COBALT-731', 5_000), 'COBALT-731');
});

test('StopFilter catches stop sequence split across deltas', () => {
  const filter = new StopFilter(['END']);
  assert.deepEqual(filter.push('abcE'), { text: 'ab', stopped: false });
  assert.deepEqual(filter.push('NDignored'), { text: 'c', stopped: true });
  assert.equal(filter.flush(), '');
});

test('controlled tool output becomes an OpenAI-style tool call payload', () => {
  const output = parseControlledOutput(JSON.stringify({
    __gateway_type: 'tool_calls',
    tool_calls: [{ name: 'weather', arguments: { city: 'Hanoi' } }],
  }), true);
  assert.equal(output.kind, 'tool_calls');
  if (output.kind !== 'tool_calls') return;
  assert.equal(output.toolCalls[0]?.name, 'weather');
  assert.equal(output.toolCalls[0]?.arguments, '{"city":"Hanoi"}');
  assert.match(output.toolCalls[0]?.id ?? '', /^call_/);
});

test('controlled normal text output unwraps the gateway envelope', () => {
  const output = parseControlledOutput('{"__gateway_type":"text","content":"hello"}', true);
  assert.deepEqual(output, { kind: 'text', content: 'hello' });
});

test('controlled output tolerates ChatGPT removing one marker underscore', () => {
  assert.deepEqual(
    parseControlledOutput('{"_gateway_type":"text","content":"Hi."}', true),
    { kind: 'text', content: 'Hi.' },
  );

  const output = parseControlledOutput(JSON.stringify({
    _gateway_type: 'tool_calls',
    tool_calls: [{ name: 'read', arguments: { filePath: '/README.md' } }],
  }), true);
  assert.equal(output.kind, 'tool_calls');
  if (output.kind !== 'tool_calls') return;
  assert.equal(output.toolCalls[0]?.name, 'read');
  assert.equal(output.toolCalls[0]?.arguments, '{"filePath":"/README.md"}');
});

test('controlled parallel tool calls repair unescaped Windows paths', () => {
  const raw = String.raw`{"_gateway_type":"tool_calls","tool_calls":[{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\README.md"}},{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\package.json"}},{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\src\server.ts"}},{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\src\api\openai.ts"}},{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\src\chatgpt\browser.ts"}},{"name":"read","arguments":{"filePath":"D:\Workspaces\Rust\Browser-LLM-Gateway\tests\compat.test.ts"}}]}`;
  const output = parseControlledOutput(raw, true);

  assert.equal(output.kind, 'tool_calls');
  if (output.kind !== 'tool_calls') return;
  assert.equal(output.toolCalls.length, 6);
  assert.equal(new Set(output.toolCalls.map((call) => call.id)).size, 6);
  assert.deepEqual(JSON.parse(output.toolCalls[0]?.arguments ?? '{}'), {
    filePath: 'D:\\Workspaces\\Rust\\Browser-LLM-Gateway\\README.md',
  });
  assert.deepEqual(JSON.parse(output.toolCalls[5]?.arguments ?? '{}'), {
    filePath: 'D:\\Workspaces\\Rust\\Browser-LLM-Gateway\\tests\\compat.test.ts',
  });
});

test('controlled tool call ignores junk appended after the JSON envelope', () => {
  const raw = '{"__gateway_type":"tool_calls","tool_calls":[{"name":"task","arguments":{"description":"Inspect repository structure","prompt":"Explore the repository.","subagent_type":"explore"}}]}]()';
  const output = parseControlledOutput(raw, true);

  assert.equal(output.kind, 'tool_calls');
  if (output.kind !== 'tool_calls') return;
  assert.equal(output.toolCalls.length, 1);
  assert.equal(output.toolCalls[0]?.name, 'task');
  assert.deepEqual(JSON.parse(output.toolCalls[0]?.arguments ?? '{}'), {
    description: 'Inspect repository structure',
    prompt: 'Explore the repository.',
    subagent_type: 'explore',
  });
});

test('JSON output strips a markdown JSON fence and validates it', () => {
  assert.equal(normalizeJsonText('```json\n{"ok":true}\n```'), '{"ok":true}');
  assert.throws(() => normalizeJsonText('not json'));
});

test('tool + JSON schema contract keeps the tool envelope as the top-level format', () => {
  const prompt = withGenerationContract('hello', {
    tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  });
  assert.match(prompt, /__gateway_type/);
  assert.match(prompt, /Escape every backslash/);
  assert.match(prompt, /content string must itself contain valid JSON/);
});
