import assert from 'node:assert/strict';
import test from 'node:test';
import { responseImages, serializeResponsesInput } from '../src/openai/prompt.ts';
import { ResponseStore, type StoredResponse } from '../src/openai/store.ts';

function storedResponse(id: string, inputItems: unknown[]): StoredResponse {
  return {
    id,
    response: { id },
    inputItems,
    contextText: '',
    contextImages: [],
    createdAt: 0,
  };
}

test('ResponseStore counts retained base64 image input strings against the image budget', () => {
  const store = new ResponseStore(10, 1_000);
  const imageUrl = `data:image/png;base64,${'A'.repeat(700)}`;

  store.set(storedResponse('first', [{ type: 'input_image', image_url: imageUrl }]));
  store.set(storedResponse('second', [{ type: 'input_image', image_url: imageUrl }]));

  assert.equal(store.get('first'), undefined);
  assert.equal(store.get('second')?.id, 'second');
});

test('Responses function_call_output image arrays are uploaded as browser images', () => {
  const input = [{
    type: 'function_call_output',
    call_id: 'call_1',
    output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }],
  }];

  const images = responseImages(input);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.mimeType, 'image/png');
  assert.deepEqual([...images[0]!.data], [1, 2, 3]);
  assert.match(serializeResponsesInput(input), /\[Image attached separately\]/);
});

test('Responses serialization rejects malformed non-content values instead of stringifying them', () => {
  assert.throws(
    () => serializeResponsesInput([{ type: 'message', role: 'user', content: 42 }]),
    /Responses content must be a string, typed object, or array/,
  );
  assert.throws(
    () => serializeResponsesInput([{ type: 'message', role: 'user', content: { text: 'missing type' } }]),
    /Responses content part type 'unknown' is not supported/,
  );
});
