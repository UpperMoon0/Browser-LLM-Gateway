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
