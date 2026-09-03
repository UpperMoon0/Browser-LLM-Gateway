# Browser-LLM-Gateway

An experimental **OpenAI-compatible LLM gateway backed by the ChatGPT web UI**. Clients talk to normal OpenAI-shaped HTTP endpoints; internally the gateway drives a persistent ChatGPT browser session with Playwright instead of calling a model API.

> This is an unofficial browser automation project. ChatGPT's frontend, rate limits, anti-automation behavior, and applicable service terms can change. Use it only where your use of the underlying website is permitted.

## What works

### Text-generation API surface

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /v1/models` | ✅ | Lists configured aliases. |
| `GET /v1/models/:model` | ✅ | Model lookup. |
| `POST /v1/chat/completions` | ✅ | Non-streaming + OpenAI-compatible SSE framing. |
| `POST /v1/completions` | ✅ | Legacy text completions, including SSE framing. |
| `POST /v1/responses` | ✅ | Modern Responses API, including SSE events. |
| `GET /v1/responses/:id` | ✅ | In-memory retrieval for stored responses. |
| `DELETE /v1/responses/:id` | ✅ | Deletes an in-memory stored response. |
| `POST /v1/responses/:id/cancel` | ⚠️ | Returns the completed response; browser generations are synchronous. |
| `GET /v1/responses/:id/input_items` | ✅ | Returns saved input items. |
| `GET /health`, `GET /v1/health` | ✅ | Browser/session health. |

All other `/v1/*` routes return an OpenAI-shaped `501 unsupported_endpoint` error instead of a generic HTML/404 response. That means OpenAI clients can call the gateway safely and get a predictable API error for capabilities that cannot honestly be provided through the ChatGPT text UI.

Because the backend observes and stabilizes a rendered webpage rather than receiving model-token deltas, SSE responses can be buffered until the current ChatGPT response is stable. Clients still receive the expected SSE event/chunk format, but should not assume token-by-token latency.

### Chat Completions compatibility

Supported/adapted:

- `system`, `developer`, `user`, `assistant`, `tool`, and legacy `function` messages
- text multipart content
- `stream: true`
- `stream_options.include_usage`
- modern `tools` / `tool_choice`
- legacy `functions` / `function_call`
- multiple emulated parallel tool calls
- `response_format: {type:"json_object"}`
- `response_format: {type:"json_schema", ...}`
- `stop`
- `n: 1`
- OpenAI-shaped errors and completion objects

Tool/function calls are **emulated**. The gateway gives the ChatGPT webpage a strict internal JSON output contract, then translates that result into OpenAI `tool_calls`/`function_call` objects. This is not the ChatGPT website exposing a native OpenAI function-calling protocol.

### Image input compatibility

Chat Completions `image_url` parts and Responses `input_image` parts are supported when their URL is a base64 `data:` URL. PNG, JPEG, GIF, and WebP are accepted. This is the format Kilo uses for images pasted or dropped into its prompt composer.

The gateway decodes each image, uploads it through ChatGPT's web composer, waits for the ChatGPT-hosted attachment preview, and then submits the serialized conversation. The text transcript includes a marker at the original content-part position so the model can associate the uploaded media with the surrounding message.

Kilo persists image file parts in its session and includes the relevant history in later OpenAI-compatible requests. Because this gateway starts a fresh ChatGPT conversation for every HTTP request, those retained images are uploaded again on the later request. This preserves request isolation: image recall comes from client-supplied context, not from keeping a hidden ChatGPT conversation alive.

For the Responses API, images are also retained in the gateway's in-memory `previous_response_id` context and re-uploaded on continuation. This state is process-local and is lost when the gateway restarts. The response store is bounded by both entry count and retained image payload: by default it keeps at most 200 responses and 128 MiB of retained image buffers, evicting the oldest entries when either limit is exceeded.

Remote HTTP(S) image URLs and `file_id` references are rejected rather than fetched by the gateway. Convert them to base64 data URLs before sending. A request may contain at most 20 images, each no larger than 20 MB decoded.

### Responses API compatibility

Supported/adapted:

- string or structured `input`
- `instructions`
- function tools + tool choice
- text output
- JSON object / JSON Schema text formatting
- `previous_response_id` continuation while the response remains in the gateway's in-memory store
- non-streaming responses
- streaming events including `response.created`, output item/content events, text deltas, function-call argument events, and `response.completed`
- stored response retrieval/deletion/input items

Unsupported Responses item/content types are rejected explicitly instead of being silently omitted from the browser transcript.

Built-in Responses tools such as hosted web search, file search, code interpreter, or computer use are **not** exposed because the browser UI does not provide their OpenAI wire-level results reliably.

## What is intentionally not faked

The following OpenAI product APIs cannot be implemented faithfully by merely typing into ChatGPT's text composer, so they return `501 unsupported_endpoint` (or `400 unsupported_feature` when embedded in a supported endpoint):

- embeddings
- image generation/editing/variations
- audio speech/transcription/translation
- moderations
- files/uploads
- batches
- fine-tuning
- vector stores
- Assistants/Threads APIs
- realtime/WebSocket APIs
- audio message parts
- log probabilities
- background Responses

Generation controls such as `temperature`, `top_p`, and exact token limits may be accepted for client schema compatibility, but the ChatGPT website does not expose equivalent deterministic controls. They are therefore not promised to affect generation.

## Architecture

```text
OpenAI SDK / compatible client
          |
          |  /v1/chat/completions
          |  /v1/responses
          |  /v1/completions
          v
      Fastify API
          |
          v
OpenAI compatibility adapters
          |
          v
 serialized browser worker
          |
          v
Playwright persistent Chromium profile
          |
          v
       chatgpt.com
```

The first version deliberately serializes browser generations through one persistent session. That is slower than an API but avoids multiple callers corrupting the same ChatGPT page state.

## Requirements

- Node.js 20+
- Chromium installed by Playwright
- a ChatGPT account you are permitted to automate

## Install

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Node does not automatically load `.env` in this project. Either export the variables in your shell or run with Node's `--env-file=.env` mechanism / your preferred process manager.

## Authenticate ChatGPT

If Google sign-in is rejected in Playwright Chromium, export the authenticated
`chatgpt.com` cookies from your normal browser in Netscape cookie-file format and
save them as `cookies.txt` in the repository root. The file is ignored by Git and
must be treated as a credential. The gateway imports unexpired cookies into its
persistent profile automatically whenever Chromium starts. You can replace the
file while the gateway is running; it fingerprints the file and imports a changed
version under the serialized browser lock before the next generation request.

```bash
npm run auth
```

When `cookies.txt` exists, this command imports it and verifies that the normal
ChatGPT composer is visible. Without a cookie file, it falls back to interactive
sign-in: sign in normally, then return to the terminal and press Enter. Interactive
authentication is also verified against the ChatGPT session endpoint and composer
before the command reports success.

Authentication is stored under `.data/chatgpt-profile` by default. **Treat both
the profile directory and `cookies.txt` as credentials.** They are ignored by Git
and excluded from the Docker build context.

### Rotate cookies while running

Replace the active cookies without restarting the gateway by sending a Netscape
cookie file to `POST /v1/auth/cookies`. The gateway validates the replacement in
an isolated browser context before persisting or applying it. The endpoint uses
the same `GATEWAY_API_KEY` protection as generation routes.

```bash
curl http://127.0.0.1:11436/v1/auth/cookies \
  -H 'Authorization: Bearer local' \
  -H 'Content-Type: text/plain' \
  --data-binary @cookies.txt
```

JSON is also accepted as `{ "cookies": "<Netscape cookie file contents>" }`.
Responses contain only import counts; cookie names and values are never returned.

## Run

```bash
npm run dev
```

Default URL: `http://127.0.0.1:11436`

The HTTP server starts even if ChatGPT authentication is missing/expired. `/health` then reports `degraded`, while generation calls return an OpenAI-shaped browser/upstream error. This is intentional so Docker/Kubernetes/process supervisors can keep the gateway running while auth is repaired.

Keyless operation is deliberately restricted to loopback binds. If `HOST` is a non-loopback address such as `0.0.0.0`, `::`, a LAN address, or a public interface, the process refuses to listen unless `GATEWAY_API_KEY` is set.

### Docker Compose

Docker Compose uses a secure default: it publishes the port only on host loopback and requires an API key because the process must listen on `0.0.0.0` inside the container.

```bash
export GATEWAY_API_KEY='replace-with-a-long-random-secret'
docker compose up --build
```

A direct Docker deployment that sets `HOST=0.0.0.0` must also provide `GATEWAY_API_KEY`.

## OpenAI SDK usage

Use any placeholder API key when `GATEWAY_API_KEY` is empty on a loopback-only deployment, because most OpenAI SDKs require a non-empty key locally.

### JavaScript / TypeScript

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'local',
  baseURL: 'http://127.0.0.1:11436/v1',
});

const result = await client.chat.completions.create({
  model: 'chatgpt-web',
  messages: [{ role: 'user', content: 'Say hello in five words.' }],
});

console.log(result.choices[0]?.message.content);
```

### Responses API

```ts
const response = await client.responses.create({
  model: 'chatgpt-web',
  input: 'Give me three names for a moon base.',
});

console.log(response.output_text);
```

### curl

```bash
curl http://127.0.0.1:11436/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "chatgpt-web",
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:11436/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "chatgpt-web",
    "stream": true,
    "messages": [{"role": "user", "content": "Count from one to five."}]
  }'
```

## Function/tool calling example

```json
{
  "model": "chatgpt-web",
  "messages": [{"role":"user","content":"What is the weather in Hanoi?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": {
        "type": "object",
        "properties": {"city":{"type":"string"}},
        "required": ["city"]
      }
    }
  }],
  "tool_choice": "auto"
}
```

If ChatGPT chooses the tool, the gateway translates its internal control JSON into a normal OpenAI `message.tool_calls` response. Send the tool result back in a normal `role: "tool"` message on the next request.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind host. Non-loopback binds require `GATEWAY_API_KEY`. |
| `PORT` | `11436` | HTTP port. |
| `HEADLESS` | `false` | Run persistent Chromium headless after authentication. |
| `CHATGPT_BROWSER_CHANNEL` | `chrome` | Playwright browser channel. Use the browser family that exported `cookies.txt`. |
| `CHATGPT_BASE_URL` | `https://chatgpt.com` | ChatGPT web root. |
| `CHATGPT_PROFILE_DIR` | `.data/chatgpt-profile` | Persistent browser state. |
| `CHATGPT_COOKIE_FILE` | `cookies.txt` | Optional Netscape-format cookie file imported whenever Chromium starts. |
| `GATEWAY_API_KEY` | empty | Optional on loopback; required for any non-loopback bind. Requires `Authorization: Bearer ...` when set. |
| `MODEL_ID` | `chatgpt-web` | Main advertised model ID. |
| `MODEL_ALIASES` | empty | Comma-separated additional advertised model names. |
| `STRICT_MODEL_NAMES` | `false` | If false, any requested model name is accepted as an alias for the currently selected ChatGPT web model. |
| `CHATGPT_NAVIGATION_TIMEOUT_MS` | `30000` | Maximum wait for navigation or composer readiness before retrying a fresh ChatGPT page. |
| `COMPOSER_TIMEOUT_MS` | `10000` | Maximum wait for one browser composer action before using the fallback/retry path. |
| `BROWSER_TIMEOUT_MS` | `600000` | Maximum wait for one ChatGPT generation. |

### Model-name caveat

By default the gateway accepts any non-empty requested model name for compatibility with clients that hard-code names such as `gpt-4o` or `gpt-5`, but **the requested string does not select that exact model in the ChatGPT UI**. It is an alias for whatever model the logged-in website session currently uses. Set `STRICT_MODEL_NAMES=true` if you want to reject unconfigured names.

## Usage accounting

The ChatGPT webpage does not expose authoritative API token accounting. Compatibility responses therefore contain **estimated** token counts using a lightweight character heuristic. Streaming endpoints also send `x-browser-llm-usage: estimated` where applicable. Do not use these numbers for billing.

## Development validation

```bash
npm run check
```

`npm run check` builds production TypeScript, type-checks source/scripts/tests, and runs the unit suite. GitHub Actions runs the same check on Node.js 20 and 22 for pushes and pull requests targeting `master`. Browser authentication/live ChatGPT access is intentionally not required by this lightweight CI job.

The unit suite checks stop-sequence handling, control-envelope parsing, tool-call conversion primitives, structured-output formatting, network-bind security, response-store memory eviction, Responses input rejection, cookie parsing, and composer recovery primitives.

## Reliability notes

This backend is inherently more brittle than a direct API:

1. ChatGPT selectors can change; update `src/chatgpt/selectors.ts` first.
2. Login state can expire; rerun `npm run auth`.
3. One browser session means requests queue behind each other.
4. SSE transport can be buffered while the gateway waits for a stable rendered answer.
5. Tool calls and structured output are prompt-enforced/emulated rather than native API features.
6. Response storage is in-memory, bounded by entry count and retained image bytes, and lost when the process restarts.
