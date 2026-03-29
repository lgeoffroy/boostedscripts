# BoostedScripts

A Firefox browser extension that lets you write, manage, and run JavaScript userscripts on any website — with an LLM assistant built right into the sidebar.

Scripts are stored locally in your browser and scoped per domain. No account required. The LLM runs against any provider you configure (local Ollama, OpenAI, Anthropic, or any OpenAI-compatible API).

---

## Features

- **Per-domain userscripts** — scripts are stored and run only on the site they were created for
- **In-browser code editor** — powered by CodeMirror with JavaScript syntax highlighting
- **LLM chat panel** — ask an AI to write or modify your scripts without leaving the browser
- **Agentic mode** — the LLM can directly apply code changes to the editor automatically
- **Multiple LLM providers** — Ollama (local), OpenAI, Anthropic Claude, Groq, OpenRouter, or any OpenAI-compatible endpoint
- **Context-aware prompts** — the LLM receives the current page URL, a DOM snapshot, and your existing script as context
- **Streaming responses** — responses appear in real time as the model generates them
- **Detachable window** — pop the sidebar out into a standalone window if you prefer

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser Tab                   │
│                                                 │
│  ┌─────────────┐         ┌───────────────────┐  │
│  │  Web Page   │◄────────│  Content Script   │  │
│  │             │ inject  │  (runner.js)      │  │
│  └─────────────┘         └────────┬──────────┘  │
│                                   │ messages     │
└───────────────────────────────────┼─────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │  Background Worker  │
                         │  (background.js)    │
                         │                     │
                         │  - Script storage   │
                         │  - LLM API calls    │
                         │  - Message routing  │
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   Sidebar / Popup   │
                         │   (sidebar.js)      │
                         │                     │
                         │  - Code editor      │
                         │  - Chat interface   │
                         │  - Script manager   │
                         └─────────────────────┘
```

### Components

| File | Role |
|------|------|
| `background.js` | Service worker — handles storage, LLM API calls, and message routing |
| `sidebar.js` / `sidebar.html` | Main UI — code editor (CodeMirror) + LLM chat panel |
| `options.js` / `options.html` | Settings page — configure LLM provider and credentials |
| `content_scripts/runner.js` | Injects and runs enabled scripts on page load |

### Script Execution

When you load a page, the content script checks `browser.storage.local` for any enabled scripts associated with that hostname. Enabled scripts are injected directly into the page context (not the extension context), so they have full access to the page's DOM, `window`, and any libraries the page loads.

### LLM Context

When you open a chat, the first message sent to the LLM includes:
- The current page URL
- A snapshot of the page's DOM (simplified)
- Your current script code

This gives the model everything it needs to write scripts that target the right elements on the right page.

### Agentic Mode

When agentic mode is enabled, the LLM is instructed to wrap code it wants to apply in a special ` ```boostedscript ` code fence. The extension detects this and automatically applies the code to the editor — no copy-pasting required.

---

## Installation

### From XPI (Firefox)

1. Download the `.xpi` file from the releases section
2. Open Firefox and go to `about:addons`
3. Click the gear icon → **Install Add-on From File...**
4. Select the downloaded `.xpi` file

> **Note**: The extension is currently under review, the release is unsigned for the moment.

### Load Unpacked (Development)

1. Clone or download this repository
2. Open Firefox and go to `about:debugging`
3. Click **This Firefox** → **Load Temporary Add-on...**
4. Select the `manifest.json` file from the project folder

---

## Setup

### 1. Open the Extension

Click the BoostedScripts icon in the toolbar. This opens the sidebar panel.

### 2. Configure Your LLM Provider

Click the **Settings** (⚙) link in the sidebar toolbar or go to `about:addons` → BoostedScripts → Preferences.

| Provider | What You Need |
|----------|--------------|
| **Ollama** (default) | Ollama running locally at `http://localhost:11434` |
| **OpenAI-compatible** | API key + base URL (works with Groq, OpenRouter, etc.) |
| **Anthropic** | Anthropic API key |

Quick-fill buttons for Groq, OpenAI, and Anthropic are available in settings.

### 3. Write a Script

1. Navigate to any website
2. Open the sidebar — the domain is shown in the toolbar
3. Click **New** to create a script for this domain
4. Write code in the editor, or describe what you want in the chat
5. Click **Save** then toggle **Enabled** to activate the script
6. Reload the page — your script runs automatically

---

## Chat & Agentic Mode

The chat panel on the right side of the sidebar lets you talk to an LLM about your script.

- **Send** — sends your message. The LLM has context about the current page and your existing code.
- **Apply Last Block** — manually applies the last code block from the chat to the editor.
- **New Chat** — clears the conversation history.
- **Agentic mode** checkbox — when checked, the LLM will automatically overwrite your editor with any code it generates (using the ` ```boostedscript ` marker).

---

## Storage

All data is stored locally in `browser.storage.local`:

```
scripts: {
  "example.com": [
    { id, name, code, enabled }
  ]
}
activeScriptByDomain: { "example.com": scriptId }
settings: { provider, apiKey, baseUrl, model, systemPrompt, agenticMode }
```

Nothing is sent to any server except the LLM API requests you explicitly trigger.

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save scripts and settings locally |
| `tabs` | Read the current tab's URL to scope scripts |
| `activeTab` | Access the active tab for DOM snapshots |
| `scripting` | Inject userscripts into pages |
| `webRequest` | Modify request headers for Ollama CORS compatibility |
| `<all_urls>` | Run userscripts on any website |

---

## License

MIT — see [LICENSE](LICENSE)
