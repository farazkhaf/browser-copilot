# Browser Copilot

Browser Copilot is an initial browser-agent prototype that lets an LLM work across the browser you are already using — reading page content, navigating tabs, following links, moving information between web apps, and carrying out multi-step tasks from natural-language instructions.

It combines compact page observations, browser actions, multi-tab state, and a persistent agent loop inside a Manifest V3 extension for Chrome and Microsoft Edge.

## Demo

[Watch the 50-second demo](https://drive.google.com/file/d/1T3XntJYTjCke10VpAbpLDme_AXg9t_C7/view?usp=sharing)


Browser Copilot reads a manager's email and an existing Gemini conversation, uses that context to fill a linked project-update form across multiple tabs, leaves the form unsubmitted for review, and drafts an acknowledgement email without sending it.

The agent operates the user's existing browser session directly. Final submit/send actions are intentionally left to the user in this demo.

## Features

- multi-tab browser control with stable session-local tab aliases
- bounded structural page state with explicit coverage
- full loaded-DOM text search and CSS queries
- targeted reads around relevant page regions
- click, fill, select, keyboard, scroll, navigation, and wait actions
- post-action verification and occlusion checks
- incremental full / delta / unchanged page observations
- asynchronous settling and simple busy-state detection
- screenshot fallback for visual reasoning
- session-style chat with follow-up messages
- compact and raw developer trace exports
- OpenAI Responses API by default, with an optional Gemini adapter

## Quick start

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository directory.
4. Open the Browser Copilot side panel.
5. Add your model provider, model, and API key in **Settings**.
6. Open the tabs you want the agent to use and send a message.

The API key is stored in extension session storage by default. If **Remember key on this device** is enabled, it is stored in extension local storage instead.

For this prototype, model API calls are made directly from the extension using the user-provided key.

## Local browser-tool fixtures

The repository includes small pages for manually exercising the browser substrate without an LLM:

```bash
python -m http.server 8000 --directory fixtures
```

Then open:

- `http://localhost:8000/tool-smoke.html`
- `http://localhost:8000/app-shell-scroll.html`

Expand **Browser tools** in the side panel to call the primitives directly.

## How it works

The extension is split into three runtime layers:

- **side panel** — chat session, model loop, settings, visible progress, and developer traces
- **service worker** — tab/navigation/screenshot glue and content-script injection
- **content runtime** — page indexing, DOM search/read, element refs, actions, verification, and structural deltas

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the tool and observation model.

## Limitations

- DOM actions are synthetic browser events; some sites require browser-level or native input.
- Only content currently materialized in the DOM can be searched. Virtualized/lazy content may require scrolling or using the site's own controls.
- Screenshots capture the visible tab, so screenshot use may bring a target tab to the foreground.
- Browser-internal and other restricted pages cannot be controlled by normal content scripts.

## Development

```bash
npm test
npm run check
```

The normal interface keeps the conversation and current browser work prominent, with previous activity collapsed by default. Expand **Developer trace** to inspect compact model/tool events, or export the raw provider trace when deeper debugging is needed.

## License

MIT. See [LICENSE](LICENSE).
