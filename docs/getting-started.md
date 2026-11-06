# Getting started

Download LearnHarness from [learnharness.ai](https://learnharness.ai) or [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases). For running from source, see [Development](development.md).

## Connect models

Open **Settings → Providers** and configure a connection:

- **Provider API keys:** use your own account and pay that provider's rates.
- **Subscription connections:** ChatGPT, GitHub Copilot, and Grok use their respective sign-in flows and account limits. They do not silently fall back to API-key billing.
- **[Claude Code](claude-code.md):** use a separately installed and authenticated CLI. Its own configuration controls routing and billing; this is not a subscription-only guarantee.
- **[Custom endpoint](custom-providers.md):** connect one OpenAI-compatible server, including a local model server. LearnHarness does not install or download models.

Choose **Strong**, **Cheap**, and **Vision** models in Settings. There are no factory model selections. New sessions start with Strong; background roles use their assigned slots or role overrides. A model selected inside an existing session belongs to that session and does not change background-role choices.

Optional web search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama search; configure a key for the engine you want to use. Research can still fetch known URLs without a search key. Dictation can use a Deepgram key, a local Whisper model, or your own transcription server (see below).

## Start a session

Choose **Teach** and describe what you want to understand. The agent probes your starting point, presents a plan, and teaches through explanations and checks. Reply naturally to accept or revise the plan.

Use the thinking fields to explain your reasoning, uncertainty, or reaction—not only your selected answer. You can type or dictate. Your confidence is self-reported, not an independent assessment.

Choose **Practice** for problems rather than a lesson. Start from selected graph material or describe material directly. Submit your thinking as you work; the model's committed solution is revealed when the problem concludes. Use **Next problem** when ready to continue.

Sessions are saved locally, including earlier messages when context is compacted. The [keyboard guide](keyboard.md) covers submission, focus, question controls, and cancellation.

## Dictation

Choose an **Engine** under **Settings → Providers → Dictation**:

- **Deepgram (cloud).** Create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher** (needed for [short-lived token minting](https://developers.deepgram.com/reference/auth/tokens/grant)) and add it below the engine. Audio streams from your browser straight to Deepgram using a short-lived token. A `403 Insufficient permissions` error while getting that token can mean the key's role is too low.
- **Whisper (on this device).** No key or account. Pick a model (Tiny ~65 MB through Large v3 Turbo ~1.1 GB; Base is the default). It downloads once from Hugging Face into the data directory's `models/` folder, and after that dictation runs fully offline on the app's local server. Set the language you speak: local Whisper can't auto-detect, so **Multilingual** transcribes as English.
- **Transcription endpoint.** Any OpenAI-compatible `/v1/audio/transcriptions` server, e.g. a local [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) or [speaches](https://speaches.ai/). Enter the base URL (for example `http://127.0.0.1:8080/v1`) and, if the server needs one, the model name (default `whisper-1`). The optional key is sent as a bearer token. The app's server makes the request, so the endpoint doesn't need CORS.

Then choose the language. With Deepgram or an endpoint, **Multilingual** recognizes the language automatically.

Use the microphone or **Mod+D** to start and stop. Review the text before sending. **Esc cancellation discards the pending transcript**; stop normally to keep it. Whisper and endpoint runs transcribe the whole recording once you stop, so expect a short spinner. The first Whisper run also waits for the model download.

## Use local files in a session

In the desktop app, use the paperclip's **Files** or **Folder** choice, or drag files/folders into the content area, to insert their local paths. Files supports any file type and multiple selections; Folder attaches one directory path, including an empty folder, without expanding or reading its contents. Newly picked or dropped known folders get a trailing directory separator so their Folder icon survives saved messages and reloads; files stay unchanged. Older unmarked paths are not retrospectively classified. The agent can then locate/read supported content on the machine running LearnHarness under the existing file-access guards; attaching a path does not grant permissions. This is **not an upload**: originals stay where they are. Ordinary browsers cannot expose these local paths through the picker or drag-and-drop; you can paste a full path instead.

The teacher can show a local raster image or request an annotated visual based on it. Displayed/annotated pictures are saved as session-owned snapshots, so those saved results no longer depend on the original file. This does not snapshot every file attachment. Offline regression tests cover snapshot/payload behavior, not the quality of model-generated annotations.

File tools are read-only but have broad filesystem access under the server's user; they are not confined to a selected folder. The sensitive-path guard blocks known credential/private locations, not all sensitive content. Review what you make available: file content read by an agent may be sent to its configured model provider. See [file-access boundaries](architecture.md#file-access-and-external-services).

## Extract into the graph

For lessons, attach material to a session instead. Use the graph's **Extract files… → Files** or **Folder** picker for Markdown, plain text, or PDFs. This is a separate import flow, not the session's path attachments. Each supported file is uploaded for processing; folders organize imported sources.

- Files are limited to **25 MiB each**. Imports queue independently, with up to three files in flight.
- PDF conversion is local text extraction, not OCR. Image-only pages are skipped and counted; scanner text can be inaccurate. Check the import's notices.
- Imported text then goes through model-based proposition/chain extraction. Local PDF conversion does not make the whole import offline.
- Completed chunks survive later failures. Retry is explicit and reprocesses the file; unchanged content is not automatically skipped. The file queue does not survive a page reload.

The graph stores propositions and reasoning chains with source provenance, **not mastery scores**. A proposition's presence is not proof that you understood or retained it. Automatic session extraction can be disabled independently of graph rendering.

## Sync your phone and computer

**Settings → Sync** keeps your sessions, knowledge graph, reviews, finished background jobs and settings the same on your computer and your phone, directly over your Wi-Fi. Nothing goes through the cloud, and there is no account to set up.

1. On the computer, turn on **Phone sync**. A QR code appears.
2. On the phone, open **Settings → Sync** and tap **Scan code**, then point the camera at the QR code.

From then on the phone syncs whenever both are on the same Wi-Fi with the app open: when it opens, every minute while it's open, and when you switch away. The QR code holds a secret key; every request is encrypted and signed with it, so nothing readable crosses the network. **New code** on the computer makes phones paired with the old one scan again.

If the phone can't reach the computer, the computer's firewall is probably blocking port 47321. On Fedora or Bazzite: `sudo firewall-cmd --permanent --add-port=47321/tcp && sudo firewall-cmd --reload`.

What merges how:

- Graph ledgers and reviews combine line by line: progress from both devices is kept, and a session deleted on one device is deleted on the other.
- A session changed on both devices since the last sync: the newer copy wins, and the other is kept in `data/.sync/conflicts/`.
- Settings merge key by key. API keys, the dictation engine, Claude Code, the custom provider and file-access folders stay per device.
- Background jobs sync once they finish, so another device never re-runs one.

<!-- Google Drive sync is switched off (GOOGLE_SYNC_ENABLED in src/core/sync-flag.ts). Its setup, for when it returns:
**Settings → Sync** can also sync through a private LearnHarness folder in your Google Drive (the `drive.appdata` space). Google requires an app identity, so you bring your own OAuth client once: create a Google Cloud project, enable the Google Drive API, set up the Google Auth Platform app and **Publish** it (otherwise the sign-in expires after 7 days), then create a **Desktop app** client and paste its ID and secret into Settings → Sync on each device. Then **Connect Google Drive** signs in in your browser.
-->

## Data, privacy, and usage

Chats, graph records, settings, and credentials live on your machine. Packaged desktop data normally lives under:

| OS | Learning-data folder |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/data` |
| Windows | `%APPDATA%\LearnHarness\data` |
| Linux | `$XDG_CONFIG_HOME/LearnHarness/data`, or `~/.config/LearnHarness/data` |

API-key files sit beside `data`, not inside it. They are plaintext with restrictive file permissions, not an encrypted vault. Keep complete profiles private; do not share credential files or raw debug captures in bug reports.

**Local storage does not mean local-only processing.** Configured models, subscription/CLI services, web research, and cloud dictation (Deepgram or a remote endpoint) can receive content. A local custom model is a separate setup choice, not an offline guarantee for other enabled services.

Click the context/cost row beneath the composer for Session stats. Dollar figures estimate known API costs; subscription, CLI, and custom-endpoint usage are not treated as free. See [context, caching, and costs](compaction-accounting.md) for the details.

Packaged apps support updates under **Settings → General**. Development builds do not run the updater. Report problems through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues), with reproduction steps and the app/OS version rather than private learning records or keys.
