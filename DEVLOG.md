# Development Log

## 2026-08-12: ChatGPT Web latency experiment

### Goal and constraints

Reduce the time between a gateway client request and the returned response while preserving ChatGPT Web as the upstream service.

The experiment explicitly excluded the OpenAI API. Authentication continues to use the persistent Playwright Chromium profile at `.data/chatgpt-profile`. The gateway's OpenAI-compatible HTTP surface and existing prompt-based compatibility features must continue to work.

### Original request path

Before this experiment, every generation performed the following work:

1. Acquire the single browser-worker mutex.
2. Start or reuse the persistent Chromium context.
3. Navigate the page to the configured ChatGPT root URL.
4. Wait for the composer, populate it, and submit the prompt.
5. Poll the last visible assistant message every 100 ms.
6. Return the response only after its DOM text remained unchanged for 3 seconds.

Although the gateway exposes streaming endpoints, `ChatGPTBrowser.generate()` yielded only once after completion. Consequently, gateway clients did not receive actual incremental model output.

### Baseline

Environment:

- Windows host
- Headed persistent Chromium session
- Authenticated ChatGPT Web profile
- Gateway at `http://127.0.0.1:11436`
- Model alias `chatgpt-web`
- Non-streaming `POST /v1/chat/completions`
- Prompt: `Reply with exactly the word OK.`

Two baseline requests took:

| Run | End-to-end time |
| --- | ---: |
| 1 | 11.964 s |
| 2 | 11.993 s |
| **Mean** | **11.979 s** |
| **Median** | **11.979 s** |

These are wall-clock observations rather than a controlled performance suite. ChatGPT service-side generation time varies, so larger future samples are required for a statistically strong comparison.

### Changes that worked

#### Reuse the loaded ChatGPT application

`openFreshChat()` now attempts to activate ChatGPT's visible New Chat link through its client-side router instead of navigating the whole document to the root URL.

The fast reset is accepted only after verifying all of the following:

- The route pathname is `/`.
- The composer exists and is empty.
- No visible assistant response remains in the active page.

If the selector, click, route transition, or verification fails, the gateway performs the original full root navigation. This fallback favors request isolation over speed.

Reset telemetry is exposed through `/health`:

- `lastResetMode`: `already_fresh`, `client_router`, or `navigation_fallback`
- `lastResetMs`: duration of the most recent reset

Observed successful client-router resets took 270-357 ms, with the main benchmark runs averaging approximately 297 ms.

#### Use the generation control as a completion signal

The browser worker now observes ChatGPT's Stop button. After the control has appeared, its disappearance is treated as the strongest available UI-level indication that generation has ended.

Stable DOM text remains a fallback because very short responses can finish between polling intervals. The fallback stability window was reduced from 3,000 ms to 750 ms.

This removes most of the fixed three-second tail without relying exclusively on a fragile control transition.

### Approaches that did not work

#### Headless launch with the saved profile

Launching the current saved profile with `HEADLESS=true` reached `https://chatgpt.com/`, but the gateway could not find a usable composer and remained degraded. The same profile worked in normal headed mode.

Do not assume that a profile authenticated in headed Chromium is immediately usable headlessly. This needs separate diagnosis before headless mode can be considered reliable.

#### Initial New Chat selector click

The first fast-reset implementation used a normal Playwright click with the full 10-second composer timeout. On the live page, an SVG in ChatGPT's expanded sidebar intercepted pointer events even though the New Chat link was visible and enabled.

That failure caused a timeout followed by full-navigation fallback. Example timings were 19.535 s and 20.733 s, worse than baseline.

The working implementation:

- Restricts the selector to visible New Chat links.
- Uses a short 1.5-second fast-reset timeout.
- Forces the click past the cosmetic overlay.
- Still verifies the blank conversation state afterward.
- Falls back to full navigation if verification fails.

#### Removing navigation without a reset

This was not implemented because it would send unrelated requests into the previous ChatGPT conversation. Keeping the page loaded is safe only when paired with a verified new-conversation transition.

#### Fully browserless ChatGPT Web transport

No private ChatGPT network protocol was implemented in this experiment. Replaying internal web requests might reduce UI overhead further, but the protocol and session requirements are not public contracts. A future implementation should remain experimental and retain the browser UI transport as a recovery path.

### Updated results

After fixing the New Chat overlay issue, three consecutive measurements were:

| Run | End-to-end time | Reset mode | Reset time |
| --- | ---: | --- | ---: |
| 1 | 9.332 s | `already_fresh` | 14 ms |
| 2 | 6.103 s | `client_router` | 305 ms |
| 3 | 6.031 s | `client_router` | 276 ms |

A later three-run steady-state sample produced:

| Run | End-to-end time | Reset mode | Reset time |
| --- | ---: | --- | ---: |
| 1 | 11.866 s | `client_router` | 315 ms |
| 2 | 6.089 s | `client_router` | 319 ms |
| 3 | 7.493 s | `client_router` | 271 ms |

Across the five post-fix steady-state/client-router observations used for the comparison (6.103, 6.031, 11.866, 6.089, and 7.493 seconds):

- Mean: 7.516 s
- Median: 6.103 s
- Mean improvement against the two-run baseline: approximately 37%
- Median improvement against the baseline: approximately 49%

The response text was `OK` in every benchmark request. Variation remains dominated by ChatGPT-side response timing, so the median is more representative of the removed local overhead than the small-sample mean.

### Statelessness and ChatGPT Memory

The gateway continues to create a new ChatGPT conversation for every HTTP generation request. The client-side reset changes page-loading behavior, not the intended request-level conversation isolation.

An isolation probe used a unique marker in one request and asked for it in a later new chat. ChatGPT recalled the marker. The same marker was still recalled after closing Chromium, relaunching the persistent profile, navigating to the root, and starting another request. This demonstrated account-level ChatGPT Memory rather than retained DOM conversation state.

The marker was subsequently removed through ChatGPT and a new-chat probe returned `NONE`.

Important consequence: neither full root navigation nor the client-side New Chat reset provides absolute statelessness when account-level Memory, custom instructions, workspace policy, or similar ChatGPT features are enabled. Deployments requiring stronger isolation should disable those account features or investigate a verifiable Temporary Chat flow.

### Validation

The optimized code passed:

- `npm run typecheck`
- `npm run test:unit` (17 tests)
- `npm run build`
- `git diff --check`

Live checks also confirmed:

- The authenticated headed browser reports healthy and ready.
- The client-router reset succeeds repeatedly.
- Responses remain correct for the exact-output benchmark.
- Navigation fallback remains available.

### Current limitations

- Requests are still serialized through one mutex and one ChatGPT page.
- Streaming endpoints still receive one complete text value rather than true incremental deltas.
- Completion detection depends on ChatGPT DOM selectors and UI behavior.
- Tool calls and structured output remain prompt-emulated and require complete buffering.
- Account-level ChatGPT features can influence otherwise separate requests.
- Headless mode was not usable with the current saved profile during this experiment.
- Benchmarks use a small sample and a very short response.

### Recommended next experiments

1. Implement prefix-delta emission while polling assistant text for ordinary unstructured output. Continue buffering tool-call and structured-output responses until their JSON envelope is complete.
2. Add repeatable latency instrumentation for queue wait, reset, composer submission, first assistant text, generation completion, and response delivery.
3. Add a benchmark script that records time to first byte and total time across short, medium, and long responses.
4. Test and document Temporary Chat as an optional stronger-isolation mode.
5. Diagnose headed versus headless profile behavior without changing the working headed default.
6. Explore a same-origin browser `fetch` transport behind an experimental flag, with automatic UI fallback and protocol-change detection.
7. Consider a pool of isolated pages or profiles only after concurrency, account limits, and cross-request isolation are tested carefully.

## 2026-08-12: Cookie-file authentication bootstrap

### Problem

The headed Playwright Chromium session could not complete Google OAuth. After a later navigation fallback, ChatGPT redirected the page into a rejected Google sign-in flow. Chromium then exited while the Node gateway retained stale context references, producing a misleading health state with `started: true` and `ready: false`.

The exported `cookies.txt` already contained the split ChatGPT session-token cookies and a valid clearance cookie, but the running gateway did not use that file. The repository's old `inject-cookies.js` was an unintegrated one-off script.

### Implementation

- Added a Netscape cookie-file parser that preserves host-only, subdomain, secure, session, expiry, and `#HttpOnly_` semantics.
- Expired cookies are skipped and cookie values are never logged.
- `CHATGPT_COOKIE_FILE` defaults to the Git-ignored `cookies.txt` file.
- Whenever Chromium starts, the gateway imports usable cookies before navigating to ChatGPT.
- A changed cookie file is detected and re-imported under the browser mutex before the next generation request, allowing credential rotation without restarting the server.
- `POST /v1/auth/cookies` accepts a Netscape file as `text/plain` or JSON, validates it in an isolated browser context, persists it only after authentication succeeds, and immediately applies it to the live browser under the mutex.
- The dedicated browser context clears stale cookies before applying the exported file.
- `npm run auth` now prefers the cookie file and verifies that the ChatGPT composer becomes visible, while retaining interactive sign-in as a fallback when no file exists.
- Browser startup now disposes stale context references and relaunches after a browser disconnect.
- Health status exposes `authSource` and `importedCookies` without exposing cookie names or values.
- Health status also exposes `cookieReloads` so runtime rotations can be confirmed.

### Result

The running development gateway restarted automatically, imported 17 unexpired cookies, reached `https://chatgpt.com/`, and reported:

```json
{
  "status": "ok",
  "browser": {
    "started": true,
    "ready": true,
    "busy": false,
    "authSource": "cookie_file",
    "importedCookies": 17,
    "url": "https://chatgpt.com/"
  }
}
```

Initial completion requests using the older export reached ChatGPT but did not follow their exact-output instructions. An independent `/api/auth/session` probe then showed that bundled headless Chromium received HTTP 403. Switching Playwright to the installed headed Chrome channel made the same probe return HTTP 200 and an authenticated user, demonstrating that the cookie export needed a matching browser family.

A fresh cookie file was subsequently rotated through `POST /v1/auth/cookies`. The endpoint accepted 20 cookies with zero expired or malformed entries, validated the session, and applied it without restarting the server. A live `What is 2 + 2? Reply with only the number.` request then returned `4` in 10.376 seconds, and health remained `ok` with `ready: true` and `authSource: cookie_file`.

Validation after this change passed TypeScript typechecking, 19 unit tests, the production build, and `git diff --check`.

## 2026-08-12: Kilo image-input compatibility

### Kilo source findings

Kilo's webview accepts PNG, JPEG, GIF, and WebP from paste and drag/drop. `FileReader.readAsDataURL()` turns each browser `File` into a base64 data URL. On send, the webview maps the attachment to `{ type: "file", mime, url, filename }`; the extension forwards that part to the Kilo session API unchanged.

The opencode session layer normalizes image size/encoding before persistence. When building the next model request, persisted non-text file parts become AI SDK file parts with the original data URL and MIME type. The OpenAI-compatible adapter consequently emits the standard Chat Completions image shape (`image_url.url`).

Image memory is request reconstruction, not implicit provider memory. Kilo persists file parts and replays relevant message history. Once a completed compaction summary exists, media before the newest real user turn is stripped to a text placeholder such as `[Attached image/png: screenshot.png]`; current-turn media remains intact. At that point the model retains only summarized/textual knowledge of an old image unless the user attaches it again.

### Gateway implementation

- Parse Chat Completions `image_url` and Responses `input_image` content parts.
- Accept Kilo-compatible base64 data URLs for PNG, JPEG, GIF, and WebP.
- Validate base64, MIME type, a 20 MB decoded per-image limit, and a 20-image request limit.
- Upload decoded bytes through ChatGPT's hidden `upload-photos-input`.
- Wait until every attachment has a ChatGPT Estuary preview URL before sending the prompt.
- Preserve an image marker at its position in the serialized role transcript.
- Re-upload every image supplied in Chat Completions history, allowing Kilo's persisted context to work while each HTTP request still uses a fresh ChatGPT conversation.
- Retain image bytes in the process-local Responses store so `previous_response_id` continuations can re-upload them.
- Increase the HTTP body limit from 10 MB to 32 MB to accommodate base64 overhead.
- Reject remote image URLs explicitly. Fetching arbitrary client URLs would introduce a server-side request-forgery surface and is unnecessary for Kilo's data-URL path.

### Completion-detection issue found

The first live vision test returned the transient UI text `Analyzing image` after 4.294 seconds. ChatGPT exposes that string inside an assistant message before the generation control reliably appears, so the existing 750 ms stable-text fallback treated it as final output.

Media requests now ignore the exact `Analyzing image(s)` status and use a 3-second stability fallback. Text-only requests retain the optimized 750 ms fallback and therefore do not pay this additional guard time.

### Live results

Using a generated 240x120 crimson PNG through `POST /v1/chat/completions`:

| Test | Result | End-to-end time |
| --- | --- | ---: |
| Initial implementation | Incorrect transient `Analyzing image` | 4.294 s |
| Vision request after completion fix | Correct `red` | 17.318 s |
| Three-message history; image only in the earlier user message | Correct recall: `red` | 18.147 s |
| Responses image followed by `previous_response_id` continuation | Correct `Blue` then `Blue` | Two requests completed within 30.2 s total |

Both continuation tests opened a fresh ChatGPT chat and re-uploaded the earlier image: once from client-supplied Chat Completions history and once from the gateway's process-local Responses store. Health remained `ok` afterward.

### Validation

- `npm run typecheck`
- `npm run test:unit` (22 tests)
- `npm run build`
- Live image recognition and multi-turn history replay

### Complex five-turn visual-memory probe

A reproducible probe was added as `npm run test:image-memory`. Its control image contains exactly three cats (orange tabby, black, white), two dogs (golden/tan retriever and black-and-white dog), and one blue tractor. The image appears only in the first user message; each later Chat Completions request sends the growing conversation history, matching Kilo's pre-compaction behavior. Since the gateway isolates requests with a fresh ChatGPT chat, it reuploads the retained first-message image on every turn.

| Turn | Question focus | Result | Time |
| --- | --- | --- | ---: |
| 1 | Full inventory | Correct counts, colors, and tractor | 37.317 s |
| 2 | Tractor color and position | Correct: blue, behind/slightly left | 40.746 s |
| 3 | Cat colors left-to-right | Correct: orange tabby, black, white | 20.024 s |
| 4 | Dog appearances left-to-right | Correct: golden/tan, black-and-white | 21.563 s |
| 5 | Exact final recall | Correct: `cats=3; dogs=2; tractors=1; tractor_color=blue` | 33.101 s |

All five turns were correct. Mean end-to-end time was 30.550 seconds and median time was 33.101 seconds. This verifies context reconstruction and media replay, not persistent visual memory inside one hidden ChatGPT Web conversation. After Kilo compacts away the original image bytes, later requests retain only its textual summary/placeholder unless the image is attached again.
