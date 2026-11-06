/**
 * Android-only source changes, applied to the STAGED copy of the repo
 * (the staging folder build.sh creates next to the repo) — never to the desktop sources. Every edit is an
 * exact-text replacement that must match once, so upstream drift fails the
 * build loudly instead of silently shipping an unpatched app.
 *
 *   1. API access: the in-app WebView proves itself with an HttpOnly cookie
 *      (Android's WebView can't add a header to every request the way the
 *      Electron shell does). Keyed by LH_ANDROID_API_SECRET so none of the
 *      Electron-only desktop paths switch on.
 *   2. Claude Code: the bundled CLI (Linux musl build + musl loader) and an
 *      in-app subscription sign-in (overlay/files).
 *   3. Dictation: an "android" engine (the platform SpeechRecognizer via the
 *      app's LHAndroidSpeech JS bridge) becomes the default; local Whisper is
 *      hidden (onnxruntime has no Android build).
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: apply.mjs <staged repo>");

function edit(rel, pairs) {
	const file = path.join(root, rel);
	let s = fs.readFileSync(file, "utf8");
	for (const [from, to] of pairs) {
		const n = s.split(from).length - 1;
		if (n !== 1) throw new Error(`[overlay] ${rel}: expected 1 match, found ${n}:\n${from}`);
		s = s.replace(from, () => to);
	}
	fs.writeFileSync(file, s);
	console.log(`[overlay] ${rel} (${pairs.length})`);
}

// New Android-only files (overlay/files mirrors the repo layout).
const filesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "files");
fs.cpSync(filesDir, root, { recursive: true });
console.log("[overlay] copied overlay/files");

// Claude Code: the bundled Linux musl build runs through musl's loader, both
// installed as native libraries (LH_CLAUDE_BIN / LH_CLAUDE_LOADER).
edit("src/agent/claude-code/binary.ts", [[
	`export function getClaudeBinary(): string | null {
	return resolveClaudeBinary({`,
	`/** Android: the CLI must be started as \`<musl loader> <cli> …args\`. */
export function claudeSpawnSpec(binary: string, args: string[]): { command: string; args: string[] } {
	const loader = process.env.LH_CLAUDE_LOADER;
	return loader ? { command: loader, args: [binary, ...args] } : { command: binary, args };
}

export function getClaudeBinary(): string | null {
	const bundled = process.env.LH_CLAUDE_BIN;
	if (bundled) return isExecutableFile(bundled) ? bundled : null;
	return resolveClaudeBinary({`,
]]);
edit("src/agent/claude-code/launch.ts", [[
	`import { getClaudeBinary } from "./binary.ts";`,
	`import { claudeSpawnSpec, getClaudeBinary } from "./binary.ts";`,
], [
	`		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });`,
	`		const spec = claudeSpawnSpec(binary, args);
		return spawnProcess(spec.command, spec.args, { cwd: options.cwd, env: options.env, stdio: "pipe" });`,
]]);
edit("src/agent/claude-code/installation.ts", [[
	`import { getClaudeBinary } from "./binary.ts";`,
	`import { claudeSpawnSpec, getClaudeBinary } from "./binary.ts";`,
], [
	`	execFile(binary, ["--version"], {`,
	`	const spec = claudeSpawnSpec(binary, ["--version"]);
	execFile(spec.command, spec.args, {`,
]]);
fs.appendFileSync(path.join(root, "src/server/index.ts"),
	`export { claudeAuthStatus, claudeLogout, finishClaudeLogin, startClaudeLogin } from "./android-claude-login.ts";\n`);
edit("components/settings/claude-code-status.tsx", [[
	`import { Toggle } from "./controls";`,
	`import { Toggle } from "./controls";
import { AndroidClaudeLogin } from "./android-claude-login";`,
], [
	`<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Install and authenticate Claude Code in your terminal, then select a Claude Code model here.</strong> LearnHarness starts it when needed—no background process required.</p>`,
	`<AndroidClaudeLogin />`,
]]);

// The staged copy lives in its own folder; pin Next's workspace root there
// (it otherwise walks up to a parent lockfile and nests the standalone output).
edit("next.config.ts", [[
	`	output: "standalone",`,
	`	output: "standalone",
	outputFileTracingRoot: process.cwd(),
	turbopack: { root: process.cwd() },`,
]]);

edit("src/server/desktop-access.ts", [[
	`	const expected = env.LH_DESKTOP_API_SECRET;`,
	`	const android = env.LH_ANDROID_API_SECRET;
	if (android) {
		const token = headers.get("x-learnharness-desktop") ?? cookieValue(headers.get("cookie"), "lh_android");
		if (!token || android.length < 64) return false;
		const got = Buffer.from(token);
		const want = Buffer.from(android);
		return got.length === want.length && timingSafeEqual(got, want);
	}
	const expected = env.LH_DESKTOP_API_SECRET;`,
], [
	`export function desktopAPIAuthorized(`,
	`function cookieValue(header: string | null, name: string): string | null {
	for (const part of header?.split(";") ?? []) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

export function desktopAPIAuthorized(`,
]]);

edit("src/core/dictation.ts", [[
	`export const DICTATION_ENGINES = ["deepgram", "whisper", "endpoint"] as const;`,
	`export const DICTATION_ENGINES = ["android", "deepgram", "whisper", "endpoint"] as const;`,
], [
	`	endpoint: "Transcription endpoint",`,
	`	android: "Android speech recognition",
	endpoint: "Transcription endpoint",`,
]]);

edit("src/core/settings.ts", [[
	`dictation: { language: "en", engine: "deepgram", whisperModel: "onnx-community/whisper-base" },`,
	`dictation: { language: "en", engine: "android", whisperModel: "onnx-community/whisper-base" },`,
]]);

edit("components/dictation-language.tsx", [[
	`{DICTATION_ENGINES.map((id) =>`,
	`{DICTATION_ENGINES.filter((id) => id !== "whisper").map((id) =>`,
]]);

edit("components/settings/keys-section.tsx", [[
	`					{dictationEngine === "endpoint" && <p data-testid="dictation-setup-hint"`,
	`					{dictationEngine === "android" && <p data-testid="dictation-setup-hint" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
						Uses Android&apos;s built-in speech recognition: no key needed. Many phones recognize speech on the device; others send audio to the phone&apos;s speech service. Choose the language you speak above.
					</p>}
					{dictationEngine === "endpoint" && <p data-testid="dictation-setup-hint"`,
]]);

edit("components/dictation.tsx", [[
	`const LOCAL_MAX_BYTES = 16000 * 2 * 60 * 15;`,
	`const LOCAL_MAX_BYTES = 16000 * 2 * 60 * 15;

/** The Android app's native SpeechRecognizer bridge (WebView JS interface).
 *  It answers with "lh:android-speech" window events: ready, level {db},
 *  final {text}, error {message}, end. */
type AndroidSpeech = { start(language: string): void; stop(): void; cancel(): void };
function androidSpeech(): AndroidSpeech | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { LHAndroidSpeech?: AndroidSpeech }).LHAndroidSpeech ?? null;
}
/** SpeechRecognizer's onRmsChanged dB (≈ -2..10) → an RMS the meter maps. */
function androidDbToRms(db: number): number {
	const t = Math.max(0, Math.min(1, (db + 2) / 12));
	return Math.pow(10, (METER_FLOOR_DB + t * (METER_CEILING_DB - METER_FLOOR_DB)) / 20);
}`,
], [
	`	const localRef = useRef<LocalRun | null>(null);`,
	`	const localRef = useRef<LocalRun | null>(null);
	/** The generation of a live Android SpeechRecognizer run, else null. */
	const androidRef = useRef<number | null>(null);`,
], [
	`		const local = localRef.current;
		localRef.current = null;
		local?.abort?.abort(); // a cancelled run's transcription is abandoned`,
	`		const local = localRef.current;
		localRef.current = null;
		local?.abort?.abort(); // a cancelled run's transcription is abandoned
		const wasAndroid = androidRef.current !== null;
		if (wasAndroid) {
			androidRef.current = null;
			androidSpeech()?.cancel();
		}`,
], [
	`		if (warmNext && !local) warmTokens.refresh();`,
	`		if (warmNext && !local && !wasAndroid) warmTokens.refresh();`,
], [
	`		if (gen !== genRef.current) return;
		if (engine !== "deepgram") {`,
	`		if (gen !== genRef.current) return;
		if (engine === "android") {
			const bridge = androidSpeech();
			if (!bridge) {
				setError("Android speech recognition is only available in the Android app");
				cleanup();
				return;
			}
			androidRef.current = gen;
			bridge.start(language === "multi" ? "" : language);
			return;
		}
		if (engine !== "deepgram") {`,
], [
	`		const local = localRef.current;
		if (local) {
			// Keyless engines: one batch transcription of the whole run.`,
	`		if (androidRef.current !== null) {
			// The recognizer delivers its last result, then "end" finishes the run.
			androidSpeech()?.stop();
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 5000);
			return;
		}

		const local = localRef.current;
		if (local) {
			// Keyless engines: one batch transcription of the whole run.`,
], [
	`	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);`,
	`	useEffect(() => {
		const onSpeech = (ev: Event) => {
			const d = (ev as CustomEvent).detail as { type: string; text?: string; db?: number; message?: string };
			if (androidRef.current === null || androidRef.current !== genRef.current) return;
			if (d.type === "ready") setPhase((p) => (p === "connecting" ? "recording" : p));
			else if (d.type === "level") levelRef.current = androidDbToRms(d.db ?? -2);
			else if (d.type === "final" && d.text) bufferRef.current.push(d.text);
			else if (d.type === "error") {
				setError(d.message ?? "Speech recognition failed");
				cleanup();
			} else if (d.type === "end") cleanup();
		};
		window.addEventListener("lh:android-speech", onSpeech);
		return () => window.removeEventListener("lh:android-speech", onSpeech);
	}, [cleanup]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);`,
]]);

// Phone layout: the desktop sidebar (w-72) can't sit beside the content on a
// ~390px screen. On narrow Android screens it starts closed, slides OVER the
// page with a tap-to-close backdrop, and closes after each navigation. The
// app shell appends "LearnHarnessAndroid" to the WebView user agent.
edit("components/sidebar.tsx", [[
	`const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");`,
	`const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
const IS_ANDROID = typeof navigator !== "undefined" && navigator.userAgent.includes("LearnHarnessAndroid");
const isPhone = () => IS_ANDROID && window.innerWidth < 768;`,
], [
	`	const [mounted, setMounted] = useState(false);
`,
	`	const [mounted, setMounted] = useState(false);
	const pathname = usePathname();
	useEffect(() => {
		if (isPhone()) setOpen(false);
	}, [pathname]);
`,
], [
	`		setOpen(stored === null ? true : stored === "1");`,
	`		if (IS_ANDROID) document.documentElement.classList.add("lh-android");
		setOpen(isPhone() ? false : stored === null ? true : stored === "1");`,
], [
	`	return (
		<aside
			className={cn("sidebar-motion shrink-0`,
	`	return (
		<>
		{IS_ANDROID && open && <div className="lh-sidebar-backdrop" onClick={toggle} aria-hidden />}
		<aside
			className={cn("lh-sidebar sidebar-motion shrink-0`,
], [
	`			</aside>
	);
}`,
	`			</aside>
		</>
	);
}`,
], [
	`onClick={() => openSettings()}`,
	`onClick={() => { if (isPhone() && open) toggle(); openSettings(); }}`,
]]);
edit("components/settings/settings-dialog.tsx", [[
	`onClick={() => setActive(s.id)}`,
	`onClick={(e) => { setActive(s.id); e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}`,
]]);

// Dictation: with no stored engine the default is "android" (the factory
// value above), not the desktop's implicit Deepgram.
edit("components/settings/keys-section.tsx", [[
	`useDictationLanguage().section.engine ?? "deepgram"`,
	`useDictationLanguage().section.engine ?? "android"`,
]]);
edit("components/dictation.tsx", [[
	`engine = settings.engine ?? "deepgram";`,
	`engine = settings.engine ?? "android";`,
], [
	`(settings.engine ?? "deepgram") === "deepgram"`,
	`(settings.engine ?? "android") === "deepgram"`,
]]);
// Dictation on phones: the composer row is too narrow for the labelled
// button, so it collapses to the mic icon (and the recording "Stop" to its
// icon); an error shows as a pill above the row (no hover tooltips on touch).
edit("components/dictation.tsx", [[
	`<span className="max-w-full truncate">{error ?? "Dictate"}</span>`,
	`{error
						? <span className="lh-dictate-error max-w-full truncate">{error}</span>
						: <span className="lh-dictate-label max-w-full truncate">Dictate</span>}`,
], [
	`<MicIcon className="size-3.5" />}
					Stop
				</button>`,
	`<MicIcon className="size-3.5" />}
					<span className="lh-dictate-label">Stop</span>
				</button>`,
]]);
// Attachments: LearnHarness attaches by path, and a WebView File has none.
// The app's LHAndroidFiles bridge opens the system picker, copies the
// selection into ~/attachments/<run>/ and answers with those paths.
edit("components/attach-files-button.tsx", [[
	`const noSubscribe = () => () => {};`,
	`type AndroidFiles = { pickFiles(): void; pickFolder(): void };
function androidFiles(): AndroidFiles | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { LHAndroidFiles?: AndroidFiles }).LHAndroidFiles ?? null;
}
/** Resolves with the copied paths, null on cancel; rejects with the app's message. */
function androidPick(kind: "files" | "folder"): Promise<string[] | null> {
	const bridge = androidFiles();
	if (!bridge) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const onFiles = (ev: Event) => {
			const d = (ev as CustomEvent).detail as { type: string; paths?: string[]; message?: string };
			window.removeEventListener("lh:android-files", onFiles);
			if (d.type === "picked") resolve(d.paths ?? []);
			else if (d.type === "error") reject(new Error(d.message ?? "Could not attach the files"));
			else resolve(null);
		};
		window.addEventListener("lh:android-files", onFiles);
		if (kind === "files") bridge.pickFiles();
		else bridge.pickFolder();
	});
}

const noSubscribe = () => () => {};`,
], [
	`() => Boolean(window.lh?.getPathForFile), () => false);`,
	`() => Boolean(window.lh?.getPathForFile) || androidFiles() !== null, () => false);`,
], [
	`		const choose = window.lh?.chooseAttachmentFolder;`,
	`		const choose = window.lh?.chooseAttachmentFolder
			?? (androidFiles() ? () => androidPick("folder").then((paths) => paths?.[0] ?? null) : undefined);`,
], [
	`	return (
		<div className="relative shrink-0"`,
	`	const attachAndroidFiles = async () => {
		const editor = editorRef.current;
		setNotice("");
		try {
			const paths = await androidPick("files");
			if (paths && paths.length > 0 && editor?.isConnected && editor === editorRef.current) {
				editor.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: paths }));
			}
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "Could not attach the files");
		}
	};
	return (
		<div className="relative shrink-0"`,
], [
	`onClick={() => { setOpen(false); pickerRef.current?.click(); }}>Files</button>`,
	`onClick={() => { setOpen(false); if (androidFiles()) void attachAndroidFiles(); else pickerRef.current?.click(); }}>Files</button>`,
]]);
// Phones: a swipe past the question/practice dock's top or bottom carries
// on into the session history (overlay/files/components/android-dock-scroll.tsx).
edit("app/layout.tsx", [[
	`import { SyncAgent } from "@/components/sync-agent";`,
	`import { SyncAgent } from "@/components/sync-agent";
import { AndroidDockScroll } from "@/components/android-dock-scroll";
import { AndroidTitleMarquee } from "@/components/android-title-marquee";`,
], [
	`			<SyncAgent />`,
	`			<SyncAgent />
			<AndroidDockScroll />
			<AndroidTitleMarquee />`,
]]);
fs.appendFileSync(path.join(root, "app/globals.css"), `
/* Android phone layout (android/overlay/apply.mjs) */
.lh-sidebar-backdrop { display: none; }
@media (max-width: 767px) {
	html.lh-android aside.lh-sidebar { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; }
	html.lh-android .lh-sidebar-backdrop { display: block; position: fixed; inset: 0; z-index: 49; background: rgb(0 0 0 / 0.5); }
}
html.lh-android, html.lh-android body { overflow-x: hidden; }
@media (max-width: 767px) {
	/* Settings: full-screen sheet, the section nav becomes a scrolling tab row. */
	html.lh-android .settings-dialog-pop { animation: none; width: 100vw; max-width: 100vw; height: 100dvh; max-height: 100dvh; border: 0; border-radius: 0; }
	html.lh-android .settings-dialog-pop > div:has(> [data-testid="settings-nav"]) { flex-direction: column; }
	html.lh-android [data-testid="settings-nav"] { width: auto; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); scrollbar-width: none; }
	html.lh-android [data-testid="settings-nav"]::-webkit-scrollbar { display: none; }
	html.lh-android [data-testid="settings-nav"] > button { flex-shrink: 0; white-space: nowrap; }
	/* Home graph chrome: the row (search, Chains, Extract files…, graph
	   settings) is wider than a phone and spilled left over the sidebar
	   button. Wrap it: search on its own line first (flex order is also
	   paint order, so the settings panel below stays on top). */
	html.lh-android .lh-wco-floating > div:first-child { flex-wrap: wrap; justify-content: flex-end; max-width: 100%; }
	html.lh-android .lh-wco-floating > div:first-child > div:has(input[aria-label="Search nodes"]) { order: -1; flex-basis: 100%; width: 100%; }
	/* Session header: a smaller title, the Plan chip as its icon. */
	html.lh-android header > button.font-title { font-size: 1.25rem; line-height: 1.75rem; }
	html.lh-android header:has(> [data-testid="plan-chip"], > [data-testid="phase-chip"]) { gap: 0.5rem; }
	html.lh-android header > [data-testid="plan-chip"] { font-size: 0; gap: 0; padding: 0.25rem; }
	/* Tables in messages: nowrap headers and the scroll wrapper let them grow
	   to ~3000px; cap them at the column and let headers and cells wrap. */
	html.lh-android table[data-streamdown="table"] { max-width: 100%; }
	html.lh-android [data-streamdown="table-header-cell"] { white-space: normal; }
	html.lh-android [data-streamdown="table-header-cell"], html.lh-android [data-streamdown="table-cell"] { padding-inline: 0.5rem; overflow-wrap: break-word; hyphens: auto; }
}
html.lh-android .lh-dictate-label { display: none; }
/* Recording: the mic stays centered where it was; the dot and level meter
   would only get a few pixels here, so the button pulses instead. */
html.lh-android [data-testid="dictation-bar"] { justify-content: center; }
html.lh-android [data-testid="dictation-bar"] > :not(button):not([data-slot="tooltip-trigger"]) { display: none; }
html.lh-android [data-testid="dictation-bar"] [data-testid="dictation-toggle"] { animation: lh-rec-pulse 1.4s ease-in-out infinite; }
@keyframes lh-rec-pulse {
	0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--destructive) 45%, transparent); }
	50% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--destructive) 0%, transparent); }
}
html.lh-android [data-testid="dictation-toggle"] { min-width: 2.25rem; padding-inline: 0.5rem; justify-content: center; gap: 0; backdrop-filter: none; }
html.lh-android [data-testid="dictation-toggle"]:has(.lh-dictate-error) { color: var(--destructive); border-color: color-mix(in oklab, var(--destructive) 50%, transparent); }
html.lh-android .lh-dictate-error {
	position: absolute; bottom: 100%; left: 0.75rem; right: 0.75rem; margin-bottom: 0.25rem;
	white-space: normal; text-align: center; pointer-events: none; z-index: 10;
	padding: 0.25rem 0.5rem; border-radius: 0.375rem; border: 1px solid var(--border);
	background: var(--card); color: var(--destructive);
}
`);
console.log("[overlay] app/globals.css (android phone layout)");

// The dock fold (quiz card ↔ slim bar): on a phone the card covers most of
// the screen, so the desktop's 120ms height morph snapped ~1500px in a
// frame or two. Scale the morph with the distance travelled and lengthen
// the content fade to match.
edit("components/chat.tsx", [[
	`			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}, [expanded]);`,
	`			{ duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}, [expanded]);`,
], [
	`			el.animate([{ height: \`\${p.height}px\` }, { height: \`\${h}px\` }], {
				duration: 120,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});`,
	`			el.animate([{ height: \`\${p.height}px\` }, { height: \`\${h}px\` }], {
				duration: Math.min(380, 140 + Math.abs(p.height - h) * 0.15),
				easing: "cubic-bezier(0.3, 0, 0, 1)",
			});`,
]]);

// Session title: the text gets its own span so a long title can slide
// through (overlay/files/components/android-title-marquee.tsx).
edit("components/chat.tsx", [[
	`							{titleText}
							</button>`,
	`							<span className="lh-title-text">{titleText}</span>
							</button>`,
]]);
fs.appendFileSync(path.join(root, "app/globals.css"), `
/* Android: a long session title slides through; renaming edits in place at
   the header's phone title size. */
html.lh-android header button.font-title.lh-marquee {
	text-overflow: clip;
	mask-image: linear-gradient(to right, transparent, #000 0.75rem, #000 calc(100% - 0.75rem), transparent);
}
html.lh-android header button.font-title > .lh-title-text { display: inline-block; white-space: nowrap; }
html.lh-android header button.font-title.lh-marquee > .lh-title-text {
	animation: lh-marquee var(--lh-marquee-time, 8s) ease-in-out infinite;
}
@keyframes lh-marquee {
	0%, 18% { transform: translateX(0); }
	50%, 68% { transform: translateX(var(--lh-marquee-dist, 0px)); }
	100% { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
	html.lh-android header button.font-title.lh-marquee > .lh-title-text { animation: none; }
	html.lh-android header button.font-title.lh-marquee { text-overflow: ellipsis; }
}
html.lh-android input[aria-label="Session title"] { font-size: 1.25rem; line-height: 1.75rem; max-width: 100%; min-width: 0; flex: 1 1 auto; field-sizing: fixed; }
`);
console.log("[overlay] app/globals.css (title marquee, floating rename)");

// Opening a long session: render the latest messages first and fill in the
// older history afterwards (overlay/files/components/android-message-window.ts).
edit("components/chat.tsx", [[
	`import { ReadingThinkingField } from "@/components/reading-thinking";`,
	`import { ReadingThinkingField } from "@/components/reading-thinking";
import { useAndroidMessageWindow } from "@/components/android-message-window";`,
], [
	`	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);`,
	`	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const lhWindow = useAndroidMessageWindow(chatId, messages);`,
], [
	`							{messages.map((m, mi) =>
								m.role === "user" && isSubagentSteer(m) ? (`,
	`							{messages.map((m, mi) =>
								!lhWindow.showMessage(mi) ? null : m.role === "user" && isSubagentSteer(m) ? (`,
], [
	`											{m.parts.map((part, pi) => {
												const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;`,
	`											{m.parts.map((part, pi) => {
												if (!lhWindow.showPart(mi, pi)) return null;
												const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;`,
]]);

// Fluidity pass (2026-11-06). Tapping a session closed the sidebar only
// once the new page had rendered (~0.8s of a dead tap): close it on tap.
edit("components/sidebar.tsx", [[
	`									onOpen={() => {
										setKbdIndex(null);
										router.push(\`/chat/\${c.id}\`);`,
	`									onOpen={() => {
										setKbdIndex(null);
										if (isPhone() && open) toggle();
										router.push(\`/chat/\${c.id}\`);`,
]]);
// Frame cost on the phone: every backdrop-filter blur is re-rendered on any
// animated frame anywhere (a moving title cost 15% dropped frames; scrolling
// and the dock fold paid it too). The surfaces are near-opaque already —
// drop the blur and fill them in. The sidebar slides on the compositor
// (transform) instead of animating its width (a layout per frame), and the
// plan marginalia (never visible at phone width) isn't kept painting.
fs.appendFileSync(path.join(root, "app/globals.css"), `
/* Android fluidity (android/overlay/apply.mjs) */
html.lh-android *, html.lh-android *::before, html.lh-android *::after { backdrop-filter: none !important; }
html.lh-android .bg-card\\/80, html.lh-android .bg-card\\/85, html.lh-android .bg-card\\/95 { background-color: color-mix(in oklab, var(--card) 97%, transparent); }
html.lh-android .bg-background\\/80, html.lh-android .bg-background\\/85 { background-color: color-mix(in oklab, var(--background) 97%, transparent); }
@media (max-width: 767px) {
	html.lh-android [data-testid="plan-marginalia"] { display: none; }
	html.lh-android aside.lh-sidebar {
		width: 18rem !important; transform: translateX(0); will-change: transform;
		transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1) !important;
	}
	html.lh-android aside.lh-sidebar[aria-hidden="true"] { transform: translateX(-100%); }
	html.lh-android .lh-sidebar-backdrop { animation: lh-fade-in 220ms ease-out; }
	@keyframes lh-fade-in { from { opacity: 0; } }
}
/* The sliding title: a few passes after it appears, and paused while typing. */
html.lh-android header button.font-title.lh-marquee > .lh-title-text { animation-iteration-count: 3; will-change: transform; }
html.lh-android.lh-editing header button.font-title.lh-marquee > .lh-title-text { animation-play-state: paused; }
`);
console.log("[overlay] app/globals.css (fluidity)");
