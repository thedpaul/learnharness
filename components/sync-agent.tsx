"use client";

/**
 * Automatic Google Drive sync, driven by the open window (the server has no
 * scheduler): once at start, every minute while visible, and when the
 * window is hidden (switching apps, closing the laptop lid). The server
 * runs one sync at a time, so overlapping triggers cost nothing.
 */
import { useEffect } from "react";

export type SyncStatusView = {
	configured: boolean;
	connected: boolean;
	email: string | null;
	auto: boolean;
	running: boolean;
	lastSync: string | null;
	lastError: string | null;
};

/** Run a sync now; resolves with the status after it. */
export async function requestSync(): Promise<SyncStatusView> {
	const res = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run" }) });
	const json = (await res.json().catch(() => ({}))) as SyncStatusView & { message?: string };
	if (!res.ok) throw new Error(json.message ?? `Sync failed (${res.status})`);
	return json;
}

const INTERVAL_MS = 60_000;

export function SyncAgent() {
	useEffect(() => {
		let stopped = false;
		const tick = async () => {
			if (stopped) return;
			try {
				const status = (await (await fetch("/api/sync", { cache: "no-store" })).json()) as SyncStatusView;
				if (status.connected && status.auto && !status.running) await requestSync();
			} catch { /* offline or signed out: the status shows the last error */ }
		};
		void tick();
		const timer = setInterval(() => { if (document.visibilityState === "visible") void tick(); }, INTERVAL_MS);
		const onVisibility = () => { void tick(); };
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	return null;
}
