import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:11436';
const imagePath = resolve(process.argv[2] ?? 'test-assets/three-cats-two-dogs-tractor.png');
const image = await readFile(imagePath);
const dataUrl = `data:image/png;base64,${image.toString('base64')}`;

type Message = {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
};

const messages: Message[] = [{
  role: 'user',
  content: [
    {
      type: 'text',
      text: 'Study this farm image carefully. State the exact counts of cats, dogs, and tractors, then briefly identify their visible colors. Do not invent objects.',
    },
    {
      type: 'image_url',
      image_url: { url: dataUrl },
      filename: basename(imagePath),
    },
  ],
}];

const followUps = [
  'What color is the tractor, and where is it relative to the animals? Answer concisely.',
  'Without changing your earlier count, list the three cats by coat color from left to right.',
  'Now list the two dogs by appearance from left to right. Keep remembering the whole scene.',
  'Final memory check: give only this format: cats=<count>; dogs=<count>; tractors=<count>; tractor_color=<color>',
];

async function complete(turn: number): Promise<string> {
  const startedAt = performance.now();
  const response = await fetch(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.GATEWAY_API_KEY ? { authorization: `Bearer ${process.env.GATEWAY_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: 'chatgpt-web', messages }),
  });
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`Turn ${turn} failed (${response.status}): ${JSON.stringify(body)}`);
  const answer = body.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw new Error(`Turn ${turn} returned no assistant text`);
  console.log(JSON.stringify({
    turn,
    seconds: Number(((performance.now() - startedAt) / 1_000).toFixed(3)),
    answer,
  }));
  return answer;
}

messages.push({ role: 'assistant', content: await complete(1) });
for (const [index, question] of followUps.entries()) {
  messages.push({ role: 'user', content: question });
  messages.push({ role: 'assistant', content: await complete(index + 2) });
}
