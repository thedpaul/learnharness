"use client";

/**
 * Settings → Sync: Google Drive sync of the learning progress (sessions,
 * graph, jobs) and settings — src/server/sync. The user brings their own
 * Google OAuth "Desktop app" client (Google requires an app identity);
 * the steps are inline so the section works without any docs site.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import { requestSync, type SyncStatusView } from "@/components/sync-agent";

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

export function SyncSection() {
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
