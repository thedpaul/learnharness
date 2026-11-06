"use client";

/**
 * Settings → Sync (src/server/sync). Phone sync is the visible flow: the
 * computer turns on Phone sync and shows a QR code; the phone scans it once
 * and from then on syncs over the Wi-Fi (lan.ts). The Google Drive flow
 * below (GoogleSync: the user brings their own OAuth "Desktop app" client)
 * stays in the tree behind GOOGLE_SYNC_ENABLED.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import { requestSync, type SyncStatusView } from "@/components/sync-agent";
import { GOOGLE_SYNC_ENABLED } from "@/src/core";

const inputClass = "h-7 w-full min-w-0 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60";
const buttonClass = "rounded-sm border border-border px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50";
const linkClass = "underline underline-offset-2 hover:text-foreground";

async function post(body: Record<string, unknown>): Promise<SyncStatusView & { url?: string }> {
	const res = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const json = (await res.json().catch(() => ({}))) as SyncStatusView & { url?: string; message?: string };
	if (!res.ok) throw new Error(json.message ?? `Request failed (${res.status})`);
	return json;
}

function when(iso: string | null): string {
	if (!iso) return "never";
	const d = new Date(iso);
	const mins = Math.round((Date.now() - d.getTime()) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	return d.toLocaleString();
}

function GoogleSync() {
	const [status, setStatus] = useState<SyncStatusView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [waiting, setWaiting] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/sync", { cache: "no-store" });
			setStatus((await res.json()) as SyncStatusView);
		} catch { /* keep the last view */ }
	}, []);
	useEffect(() => {
		void refresh();
		return () => clearInterval(pollRef.current);
	}, [refresh]);

	const act = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError(null);
		try {
			const next = await post(body);
			setStatus(next);
			return next;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Something went wrong");
			return null;
		} finally {
			setBusy(false);
		}
	};

	const connect = async () => {
		const res = await act({ action: "connect" });
		if (!res?.url) return;
		window.open(res.url, "_blank", "noopener");
		setWaiting(true);
		const started = Date.now();
		clearInterval(pollRef.current);
		pollRef.current = setInterval(async () => {
			const s = (await (await fetch("/api/sync", { cache: "no-store" })).json()) as SyncStatusView;
			setStatus(s);
			if (s.connected || Date.now() - started > 10 * 60_000) {
				clearInterval(pollRef.current);
				setWaiting(false);
				if (s.connected) void requestSync();
			}
		}, 2000);
	};

	const syncNow = async () => {
		setBusy(true);
		setError(null);
		try {
			setStatus(await requestSync());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Sync failed");
			void refresh();
		} finally {
			setBusy(false);
		}
	};

	if (!status) return <p className="text-xs text-muted-foreground">Loading…</p>;

	const showSetup = !status.configured || editing;
	return (
		<>
			<p className="text-xs leading-relaxed text-muted-foreground">
				Keeps your sessions, knowledge graph and settings the same on every device, through a private
				LearnHarness folder in your Google Drive. API keys and device settings (dictation, Claude Code,
				file access) stay on each device.
			</p>

			{showSetup ? (
				<SettingsGroup label="Google setup (once)" testid="sync-setup">
					<ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
						<li>
							In <a className={linkClass} href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud</a>, create a project.
						</li>
						<li>
							Enable the <a className={linkClass} href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a>.
						</li>
						<li>
							Under <a className={linkClass} href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>,
							set up the app (External, your email as contact), then on Audience press <b>Publish app</b> so the sign-in doesn&apos;t expire after 7 days.
						</li>
						<li>
							Under <a className={linkClass} href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Clients</a>,
							create a client of type <b>Desktop app</b> and paste its ID and secret below. Use the same client on every device.
						</li>
					</ol>
					<input className={inputClass} placeholder="Client ID (…apps.googleusercontent.com)" aria-label="Google client ID"
						value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="sync-client-id" autoComplete="off" />
					<input className={inputClass} placeholder="Client secret" aria-label="Google client secret" type="password"
						value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} data-testid="sync-client-secret" autoComplete="off" />
					<div className="flex gap-2">
						<button type="button" className={buttonClass} disabled={busy || !clientId.trim() || !clientSecret.trim()} data-testid="sync-save-client"
							onClick={async () => {
								if (await act({ action: "configure", clientId, clientSecret })) { setEditing(false); setClientSecret(""); }
							}}>
							Save
						</button>
						{editing && <button type="button" className={buttonClass} onClick={() => setEditing(false)}>Cancel</button>}
					</div>
				</SettingsGroup>
			) : !status.connected ? (
				<SettingsGroup label="Google Drive" testid="sync-connect">
					<p className="text-xs text-muted-foreground">
						{waiting ? "Finish signing in in your browser, then come back here." : "Sign in with the Google account whose Drive should hold your progress."}
					</p>
					<div className="flex gap-2">
						<button type="button" className={buttonClass} disabled={busy} onClick={() => void connect()} data-testid="sync-connect-button">
							{waiting ? "Open sign-in again" : "Connect Google Drive"}
						</button>
						<button type="button" className={buttonClass} onClick={() => setEditing(true)}>Change client</button>
					</div>
				</SettingsGroup>
			) : (
				<SettingsGroup label="Google Drive" testid="sync-connected">
					<SettingsRow label="Connected" hint={status.email ?? "Google account"}>
						<button type="button" className={buttonClass} disabled={busy} onClick={() => void act({ action: "disconnect" })} data-testid="sync-disconnect">
							Disconnect
						</button>
					</SettingsRow>
					<SettingsRow label="Sync automatically" hint="When the app opens, every minute while open, and when you leave it">
						<Toggle checked={status.auto} label="Sync automatically" onChange={(on) => void act({ action: "auto", on })} />
					</SettingsRow>
					<SettingsRow label="Last sync" hint={status.running || busy ? "Syncing…" : when(status.lastSync)}>
						<button type="button" className={buttonClass} disabled={busy || status.running} onClick={() => void syncNow()} data-testid="sync-now">
							Sync now
						</button>
					</SettingsRow>
					{status.lastError && !error && <p className="text-xs text-red-500" data-testid="sync-last-error">Last sync failed: {status.lastError}</p>}
				</SettingsGroup>
			)}
			{error && <p className="text-xs text-red-500" role="alert" data-testid="sync-error">{error}</p>}
		</>
	);
}

// ─── phone sync ─────────────────────────────────────────────────────────────

const FIREWALL_HINT = "sudo firewall-cmd --permanent --add-port=47321/tcp && sudo firewall-cmd --reload";

export function SyncSection() {
	const [status, setStatus] = useState<SyncStatusView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [otherWay, setOtherWay] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/sync", { cache: "no-store" });
			if (res.ok) setStatus((await res.json()) as SyncStatusView);
		} catch { /* keep the last view */ }
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	// While the code shows, watch for the phone's first sync.
	const hubOn = status?.lan.hub.on ?? false;
	useEffect(() => {
		if (!hubOn) return;
		const timer = setInterval(() => void refresh(), 4000);
		return () => clearInterval(timer);
	}, [hubOn, refresh]);

	const act = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError(null);
		try {
			setStatus(await post(body));
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Something went wrong");
			void refresh();
			return false;
		} finally {
			setBusy(false);
		}
	};

	if (!status) return <p className="text-xs text-muted-foreground">Loading…</p>;
	const phone = status.lan.platform === "android";
	const showHub = !phone || otherWay;
	const showPair = phone || otherWay || status.lan.client.paired;
	return (
		<>
			<p className="text-xs leading-relaxed text-muted-foreground">
				Keeps your sessions, knowledge graph, reviews and settings the same on your computer and your phone,
				directly over your Wi-Fi: nothing goes through the cloud. API keys and device settings (dictation,
				Claude Code, file access) stay on each device.
			</p>
			{showHub && <HubGroup status={status} busy={busy} act={act} />}
			{showPair && <PairGroup status={status} busy={busy} act={act} setStatus={setStatus} setError={setError} />}
			{!otherWay && !status.lan.client.paired && (
				<button type="button" className="self-start font-ui text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
					onClick={() => setOtherWay(true)} data-testid="sync-other-way">
					{phone ? "Use this device as the hub instead" : "Pair this computer with another computer instead"}
				</button>
			)}
			{error && <p className="text-xs text-red-500" role="alert" data-testid="sync-error">{error}</p>}
			{GOOGLE_SYNC_ENABLED && <GoogleSync />}
		</>
	);
}

type Act = (body: Record<string, unknown>) => Promise<boolean>;

function HubGroup({ status, busy, act }: { status: SyncStatusView; busy: boolean; act: Act }) {
	const hub = status.lan.hub;
	const [showFirewall, setShowFirewall] = useState(false);
	return (
		<SettingsGroup label="This computer" testid="sync-hub">
			<SettingsRow label="Phone sync" hint="Lets your phone sync with this computer while both are on the same Wi-Fi">
				<Toggle checked={hub.on} disabled={busy} label="Phone sync" onChange={(on) => void act({ action: "hub", on })} />
			</SettingsRow>
			{hub.on && hub.qrSvg && (
				<div className="flex flex-col items-center gap-3 py-2" data-testid="sync-qr">
					{/* The SVG comes from this app's own server (the qrcode package). */}
					<div className="size-48 rounded-md bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: hub.qrSvg }} />
					<p className="max-w-xs text-center text-xs leading-relaxed text-muted-foreground">
						On your phone, open LearnHarness → Settings → Sync → <b>Scan code</b>.
					</p>
					<p className="font-mono text-[0.7rem] text-muted-foreground" data-testid="sync-hub-address">
						{hub.addresses[0]}:{hub.port}
						{hub.lastPeer ? ` · last sync: ${hub.lastPeer.device}, ${when(hub.lastPeer.at)}` : " · waiting for your phone…"}
					</p>
				</div>
			)}
			{hub.on && hub.error && <p className="text-xs text-red-500" data-testid="sync-hub-error">{hub.error}</p>}
			{hub.on && (
				<SettingsRow label="New code" hint="Phones paired with the current code have to scan again">
					<button type="button" className={buttonClass} disabled={busy} onClick={() => void act({ action: "hub-renew" })} data-testid="sync-hub-renew">
						New code
					</button>
				</SettingsRow>
			)}
			{hub.on && (
				<p className="text-xs leading-relaxed text-muted-foreground">
					Phone can&apos;t connect?{" "}
					<button type="button" className={linkClass} onClick={() => setShowFirewall((v) => !v)}>Allow it through the firewall</button>
					{showFirewall && (
						<>
							: this computer&apos;s firewall may block port {hub.port}. On Fedora or Bazzite, run in a terminal:
							<code className="mt-1 block select-all rounded-sm bg-muted px-2 py-1 font-mono text-[0.7rem]">{FIREWALL_HINT}</code>
						</>
					)}
				</p>
			)}
		</SettingsGroup>
	);
}

function PairGroup({ status, busy, act, setStatus, setError }: {
	status: SyncStatusView;
	busy: boolean;
	act: Act;
	setStatus: (s: SyncStatusView) => void;
	setError: (e: string | null) => void;
}) {
	const client = status.lan.client;
	const [scanning, setScanning] = useState(false);
	const [pasting, setPasting] = useState(false);
	const [code, setCode] = useState("");
	const [syncing, setSyncing] = useState(false);

	const pair = async (text: string) => {
		setScanning(false);
		if (await act({ action: "pair", code: text })) {
			setPasting(false);
			setCode("");
		}
	};
	const syncNow = async () => {
		setSyncing(true);
		setError(null);
		try {
			setStatus(await requestSync());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Sync failed");
		} finally {
			setSyncing(false);
		}
	};

	if (client.paired) {
		const running = syncing || status.running;
		return (
			<SettingsGroup label="Synced with a computer" testid="sync-paired">
				<SettingsRow label={client.hubName ?? "Computer"} hint="Paired">
					<button type="button" className={buttonClass} disabled={busy} onClick={() => void act({ action: "unpair" })} data-testid="sync-unpair">
						Unpair
					</button>
				</SettingsRow>
				<SettingsRow label="Sync automatically" hint="When the app opens, every minute while open, and when you leave it">
					<Toggle checked={client.auto} label="Sync automatically" onChange={(on) => void act({ action: "lan-auto", on })} />
				</SettingsRow>
				<SettingsRow label="Last sync" hint={running ? "Syncing…" : when(client.lastSync)}>
					<button type="button" className={buttonClass} disabled={busy || running} onClick={() => void syncNow()} data-testid="sync-now">
						Sync now
					</button>
				</SettingsRow>
				{client.lastError && !running && <p className="text-xs text-red-500" data-testid="sync-last-error">Last sync failed: {client.lastError}</p>}
			</SettingsGroup>
		);
	}
	return (
		<SettingsGroup label="Pair with your computer" testid="sync-pair">
			<p className="text-xs leading-relaxed text-muted-foreground">
				On your computer, open LearnHarness → Settings → Sync and turn on <b>Phone sync</b>. Then scan the code it shows.
			</p>
			{scanning ? (
				<QrScanner onCode={(text) => void pair(text)} onCancel={() => setScanning(false)} onPaste={() => { setScanning(false); setPasting(true); }} />
			) : (
				<div className="flex gap-2">
					<button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(null); setScanning(true); }} data-testid="sync-scan">
						{busy ? "Pairing…" : "Scan code"}
					</button>
					{!pasting && (
						<button type="button" className={buttonClass} disabled={busy} onClick={() => setPasting(true)} data-testid="sync-paste-open">
							Paste code instead
						</button>
					)}
				</div>
			)}
			{pasting && (
				<div className="flex gap-2">
					<input className={inputClass} placeholder="lhsync:1:…" aria-label="Pairing code" value={code}
						onChange={(e) => setCode(e.target.value)} data-testid="sync-code" autoComplete="off" spellCheck={false} />
					<button type="button" className={buttonClass} disabled={busy || !code.trim()} onClick={() => void pair(code)} data-testid="sync-pair-button">
						Pair
					</button>
				</div>
			)}
		</SettingsGroup>
	);
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type DetectorCtor = new (options: { formats: string[] }) => Detector;

/** The camera and the browser's BarcodeDetector; a paste field otherwise. */
function QrScanner({ onCode, onCancel, onPaste }: { onCode: (text: string) => void; onCancel: () => void; onPaste: () => void }) {
	const video = useRef<HTMLVideoElement>(null);
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
		if (!Ctor) {
			setProblem("This device can't read QR codes here. Paste the code instead.");
			return;
		}
		let stream: MediaStream | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const detector = new Ctor({ formats: ["qr_code"] });
		const scan = async () => {
			if (stopped) return;
			const v = video.current;
			if (v && v.readyState >= 2) {
				try {
					const hit = (await detector.detect(v)).find((c) => c.rawValue.startsWith("lhsync:"));
					if (hit && !stopped) {
						stopped = true;
						onCode(hit.rawValue);
						return;
					}
				} catch { /* a frame it couldn't read */ }
			}
			timer = setTimeout(() => void scan(), 200);
		};
		navigator.mediaDevices
			?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
			.then((s) => {
				if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
				stream = s;
				if (video.current) {
					video.current.srcObject = s;
					void video.current.play().catch(() => undefined);
				}
				void scan();
			})
			.catch(() => setProblem("No camera access. Allow the camera for LearnHarness, or paste the code instead."));
		return () => {
			stopped = true;
			clearTimeout(timer);
			stream?.getTracks().forEach((t) => t.stop());
		};
	}, [onCode]);

	return (
		<div className="flex flex-col items-center gap-2" data-testid="sync-scanner">
			{problem ? (
				<p className="text-xs text-red-500">{problem}</p>
			) : (
				<video ref={video} muted playsInline className="aspect-square w-full max-w-64 rounded-md bg-black object-cover" />
			)}
			<div className="flex gap-2">
				<button type="button" className={buttonClass} onClick={onCancel}>Cancel</button>
				<button type="button" className={buttonClass} onClick={onPaste}>Paste code instead</button>
			</div>
		</div>
	);
}
