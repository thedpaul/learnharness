"use client";

/**
 * Automatic sync, driven by the open window (the server has no scheduler):
 * once at start, every minute while visible, and when the window is hidden
 * (switching apps, closing the laptop lid). A paired phone syncs with its
 * computer; Google Drive when that is switched on. The server runs one sync
 * at a time, so overlapping triggers cost nothing. The status read also
 * restarts the computer's phone-sync listener after a relaunch.
 */
import { useEffect } from "react";
import { GOOGLE_SYNC_ENABLED, SYNC_ENABLED } from "@/src/core";

export type LanStatusView = {
	platform: "android" | "desktop";
	hub: {
		on: boolean;
		listening: boolean;
		port: number;
		addresses: string[];
		code: string | null;
		qrSvg: string | null;
		lastPeer: { device: string; at: string } | null;
		error: string | null;
	};
	client: { paired: boolean; hubName: string | null; auto: boolean; lastSync: string | null; lastError: string | null };
};

export type SyncStatusView = {
	configured: boolean;
	connected: boolean;
	email: string | null;
	auto: boolean;
	running: boolean;
	lastSync: string | null;
	lastError: string | null;
	lan: LanStatusView;
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
		if (!SYNC_ENABLED) return;
		let stopped = false;
		const tick = async () => {
			if (stopped) return;
			try {
				const status = (await (await fetch("/api/sync", { cache: "no-store" })).json()) as SyncStatusView;
				if (status.running) return;
				const lan = status.lan?.client;
				if (lan?.paired ? lan.auto : GOOGLE_SYNC_ENABLED && status.connected && status.auto) await requestSync();
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
