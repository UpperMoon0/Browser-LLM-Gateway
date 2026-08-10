# Browser-LLM-Gateway

An experimental OpenAI-compatible HTTP gateway that drives the **ChatGPT web UI** with Playwright instead of calling an LLM API directly.

## Scope

Initial scaffold intentionally supports only:

- `GET /v1/models`
- `POST /v1/chat/completions`
- non-streaming responses
- OpenAI-style SSE streaming (`stream: true`)
- one persistent ChatGPT browser profile
- one in-flight ChatGPT request at a time

It does **not** expose Gemini-native routes and does not call Gemini/OpenAI model APIs.

## Architecture

```text
OpenAI-compatible client
        |
        v
Fastify /v1/chat/completions
        |
        v
message serializer
        |
        v
ChatGPTBrowser
        |
        v
Playwright persistent Chromium profile
        |
        v
chatgpt.com UI
```

All fragile ChatGPT UI selectors live in `src/chatgpt/selectors.ts` so UI changes are isolated from the API layer.

## Setup

Requires Node.js 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Environment variables are read from the process environment. If you want `.env` auto-loading, launch Node with `--env-file=.env` or add your preferred env loader.

### 1. Authenticate ChatGPT

```bash
npm run auth
```

A Chromium window opens using `.data/chatgpt-profile`. Sign in normally. When the ChatGPT composer is visible, return to the terminal and press Enter.

The profile directory contains authenticated browser state and is gitignored. Treat it like a credential.

### 2. Start the gateway

```bash
npm run dev
```

Default address: `http://127.0.0.1:11436`

### 3. Test it

```bash
curl http://127.0.0.1:11436/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web",
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:11436/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web",
    "stream": true,
    "messages": [{"role": "user", "content": "Count from one to five."}]
  }'
```

## Compatibility notes

The ChatGPT web UI does not expose every parameter that the OpenAI API does. The scaffold currently accepts common fields such as `temperature`, `top_p`, and token limits for client compatibility, but the browser backend does not apply them yet.

Conversation history from the API request is serialized into a role-tagged transcript and sent into a fresh ChatGPT web conversation. This avoids leaking one API caller's web conversation state into another request.

## Current limitations

- ChatGPT frontend selectors can change.
- Only text message parts are supported.
- Tools/function calling are not implemented.
- Browser authentication may expire and require `npm run auth` again.
- One persistent browser worker means requests are serialized.
- The currently selected ChatGPT web model is controlled by the web UI; the only advertised API model ID is `chatgpt-web`.
- Usage/token counts are not reported because the web UI does not expose authoritative API token accounting.

## Next milestones

1. Harden UI state detection and selector fallbacks.
2. Detect/login health without failing server startup.
3. Add browser/session health endpoint.
4. Add account/session pool and bounded request queue.
5. Add model-selection adapters where the ChatGPT UI exposes stable controls.
6. Add conformance tests against LLM-Wrapper's OpenAI-compatible contract.

## Disclaimer

This is an unofficial browser automation gateway. Website behavior, anti-automation measures, rate limits, and applicable service terms can change. Use it only where your use of the underlying website is permitted.
