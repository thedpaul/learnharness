/**
 * Phone sync, the service: the computer runs the hub (lan-hub.ts) and shows
 * a QR code; the phone scans it once and from then on syncs with the
 * computer over the Wi-Fi. No accounts, no cloud.
 *
 * Config lives in sync-lan.json next to auth.json (mode 0600: it holds the
 * pairing secret). Each side keeps its own sync base (engine stateDir), so
 * a base agreed with Google Drive or another computer never reads as
 * deletions here:
 *   computer: data/.sync/lan-hub/{hub.json, files/, state/}
 *   phone:    data/.sync/lan-client/ — reset whenever the hub id changes.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import QRCode from "qrcode";
import { AUTH_FILE, PATHS } from "../../../config.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { announce } from "./announce.ts";
import { runSync, type SyncResult } from "./engine.ts";
import { folderRemote } from "./folder-remote.ts";
import { httpRemote, HubUnreachable, lanClient, type LanCall } from "./http-remote.ts";
import { createHubServer, listen } from "./lan-hub.ts";
import { decodePairCode, encodePairCode, LAN_DEFAULT_PORT, newSecret } from "./lan-crypto.ts";

type LanConfig = {
	hub?: { on: boolean; port: number; secret: string; lastPeer?: { device: string; at: string } };
	client?: {
		hosts: string[];
		port: number;
		secret: string;
		hubId: string;
		hubName: string;
		/** The address that answered last: tried first next time. */
		lastHost?: string;
		auto: boolean;
		lastSync?: string;
		lastError?: string;
	};
};

const configFile = () => path.join(path.dirname(AUTH_FILE), "sync-lan.json");

function readConfig(): LanConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(configFile(), "utf-8")) as unknown;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as LanConfig) : {};
	} catch {
		return {};
	}
}

function writeConfig(next: LanConfig): void {
	fs.mkdirSync(path.dirname(configFile()), { recursive: true });
	writeFileAtomicSync(configFile(), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
}

const hubDir = () => path.join(PATHS.data, ".sync", "lan-hub");
const clientStateDir = () => path.join(PATHS.data, ".sync", "lan-client");

/** The Android launcher (ServerService.java) says so; Node there reports linux. */
const onAndroid = () => process.env.LH_PLATFORM === "android" || process.platform === "android";
export const deviceName = () => process.env.LH_DEVICE_NAME?.trim().slice(0, 80) || (onAndroid() ? "Android phone" : os.hostname());

/** IPv4 addresses the phone can try: private LAN ranges first. */
export function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
	}
	const rank = (ip: string) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
	return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

// ─── the hub (computer) ─────────────────────────────────────────────────────

type HubSlot = { server?: http.Server; port?: number; secret?: string; error?: string };
const hubKey = "__lhLanHub";
function hubSlot(): HubSlot {
	const g = globalThis as typeof globalThis & { [hubKey]?: HubSlot };
	return (g[hubKey] ??= {});
}

function hubId(): string {
	const file = path.join(hubDir(), "hub.json");
	try {
		const id = (JSON.parse(fs.readFileSync(file, "utf-8")) as { id?: unknown }).id;
		if (typeof id === "string" && id) return id;
	} catch { /* new hub */ }
	const id = randomUUID();
	fs.mkdirSync(hubDir(), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify({ id }));
	return id;
}

async function syncDesktopWithHub(): Promise<void> {
	const result = await runSync(PATHS.data, folderRemote(path.join(hubDir(), "files")), undefined, { stateDir: path.join(hubDir(), "state") });
	announce(result);
}

async function stopHubServer(): Promise<void> {
	const slot = hubSlot();
	const server = slot.server;
	slot.server = undefined;
	slot.port = undefined;
	slot.secret = undefined;
	if (server) await new Promise<void>((r) => server.close(() => r()));
}

/** Start (or restart with a new secret) the listener the config asks for. */
export async function ensureHub(): Promise<void> {
	const hub = readConfig().hub;
	const slot = hubSlot();
	if (!hub?.on) {
		await stopHubServer();
		return;
	}
	if (slot.server && slot.secret === hub.secret && slot.port === hub.port) return;
	await stopHubServer();
	const server = createHubServer({
		secret: Buffer.from(hub.secret, "base64url"),
		filesDir: path.join(hubDir(), "files"),
		hubId: hubId(),
		name: deviceName(),
		syncDesktop: syncDesktopWithHub,
		onPeerSynced: (device) => {
			const c = readConfig();
			if (c.hub) writeConfig({ ...c, hub: { ...c.hub, lastPeer: { device, at: new Date().toISOString() } } });
		},
	});
	try {
		slot.port = await listen(server, hub.port);
		slot.server = server;
		slot.secret = hub.secret;
		slot.error = undefined;
	} catch (err) {
		slot.error = (err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${hub.port} is in use by another program` : String(err);
	}
}

export async function setHub(on: boolean): Promise<void> {
	const c = readConfig();
	const hub = c.hub ?? { on, port: LAN_DEFAULT_PORT, secret: newSecret().toString("base64url") };
	writeConfig({ ...c, hub: { ...hub, on } });
	await ensureHub();
}

/** A new code: phones paired with the old one have to scan again. */
export async function renewHubSecret(): Promise<void> {
	const c = readConfig();
	if (!c.hub) return;
	writeConfig({ ...c, hub: { ...c.hub, secret: newSecret().toString("base64url") } });
	await ensureHub();
}

// ─── the client (phone) ─────────────────────────────────────────────────────

function callerFor(client: NonNullable<LanConfig["client"]>, host: string): LanCall {
	return lanClient(`http://${host}:${client.port}`, Buffer.from(client.secret, "base64url"), deviceName());
}

/** The first address that answers hello (tried together, last good first). */
async function reach(client: NonNullable<LanConfig["client"]>): Promise<{ host: string; call: LanCall; hello: Record<string, unknown> }> {
	const hosts = client.lastHost ? [client.lastHost, ...client.hosts.filter((h) => h !== client.lastHost)] : client.hosts;
	try {
		return await Promise.any(hosts.map(async (host) => {
			const call = callerFor(client, host);
			return { host, call, hello: await call("hello", {}, 4000) };
		}));
	} catch (err) {
		const errors = err instanceof AggregateError ? err.errors : [err];
		const real = errors.find((e) => !(e instanceof HubUnreachable));
		if (real) throw real;
		throw new Error("Can't reach the computer. Check that it's on the same Wi-Fi with Phone sync on.");
	}
}

/** Pair with the code from the computer's QR; does not sync yet. */
export async function pairWith(text: string): Promise<{ hubName: string }> {
	const code = decodePairCode(text);
	if (!code) throw new Error("That isn't a LearnHarness pairing code");
	const draft = { hosts: code.hosts, port: code.port, secret: code.secret.toString("base64url"), hubId: "", hubName: "", auto: true };
	const { host, hello } = await reach(draft);
	const id = String(hello.hubId ?? "");
	const prev = readConfig().client;
	// A different computer: the old base would read as deletions.
	if (!prev || prev.hubId !== id) fs.rmSync(clientStateDir(), { recursive: true, force: true });
	writeConfig({ ...readConfig(), client: { ...draft, hubId: id, hubName: String(hello.name ?? "Computer"), lastHost: host } });
	return { hubName: String(hello.name ?? "Computer") };
}

export function unpair(): void {
	const c = readConfig();
	delete c.client;
	writeConfig(c);
	fs.rmSync(clientStateDir(), { recursive: true, force: true });
}

export function setLanAuto(on: boolean): void {
	const c = readConfig();
	if (c.client) writeConfig({ ...c, client: { ...c.client, auto: on } });
}

export const lanPaired = () => Boolean(readConfig().client);

/** One phone sync: begin → the engine against the hub → end. */
export async function lanSyncOnce(): Promise<SyncResult> {
	const client = readConfig().client;
	if (!client) throw new Error("Not paired with a computer");
	const record = (patch: Partial<NonNullable<LanConfig["client"]>>) => {
		const c = readConfig();
		if (c.client) writeConfig({ ...c, client: { ...c.client, ...patch } });
	};
	try {
		const { host, call, hello } = await reach(client);
		if (String(hello.hubId) !== client.hubId) {
			// The computer's hub was reset: start from a clean base.
			fs.rmSync(clientStateDir(), { recursive: true, force: true });
			record({ hubId: String(hello.hubId) });
		}
		await call("begin");
		let result: SyncResult;
		try {
			result = await runSync(PATHS.data, httpRemote(call), undefined, { stateDir: clientStateDir() });
		} finally {
			await call("end").catch(() => undefined);
		}
		record({ lastHost: host, lastSync: new Date().toISOString(), lastError: undefined });
		announce(result);
		return result;
	} catch (err) {
		record({ lastError: err instanceof Error ? err.message : String(err) });
		throw err;
	}
}

// ─── status ─────────────────────────────────────────────────────────────────

export type LanStatus = {
	/** "android" → the phone flow first; otherwise the computer flow. */
	platform: "android" | "desktop";
	hub: {
		on: boolean;
		listening: boolean;
		port: number;
		addresses: string[];
		/** The pairing code and its QR (only while on). */
		code: string | null;
		qrSvg: string | null;
		lastPeer: { device: string; at: string } | null;
		error: string | null;
	};
	client: { paired: boolean; hubName: string | null; auto: boolean; lastSync: string | null; lastError: string | null };
};

export async function lanStatus(): Promise<LanStatus> {
	await ensureHub().catch(() => undefined);
	const c = readConfig();
	const slot = hubSlot();
	const addresses = lanAddresses();
	const listening = Boolean(slot.server);
	const code = c.hub?.on && listening && addresses.length > 0
		? encodePairCode({ hosts: addresses, port: slot.port!, secret: Buffer.from(c.hub.secret, "base64url") })
		: null;
	return {
		platform: onAndroid() ? "android" : "desktop",
		hub: {
			on: Boolean(c.hub?.on),
			listening,
			port: slot.port ?? c.hub?.port ?? LAN_DEFAULT_PORT,
			addresses,
			code,
			qrSvg: code ? await QRCode.toString(code, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null,
			lastPeer: c.hub?.lastPeer ?? null,
			error: !c.hub?.on ? null : addresses.length === 0 ? "No network connection" : listening ? null : (slot.error ?? null),
		},
		client: {
			paired: Boolean(c.client),
			hubName: c.client?.hubName ?? null,
			auto: c.client?.auto ?? true,
			lastSync: c.client?.lastSync ?? null,
			lastError: c.client?.lastError ?? null,
		},
	};
}
