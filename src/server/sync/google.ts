/**
 * Google sign-in and Drive access for sync. The OAuth client is the user's
 * own (a "Desktop app" client from Google Cloud, pasted into Settings →
 * Sync): Google requires an app identity and LearnHarness ships none.
 *
 * Sign-in is the installed-app loopback flow with PKCE: the browser comes
 * back to http://127.0.0.1:<port>/oauth/google/callback on THIS server
 * (outside /api, so the browser needs no app capability; the one-time
 * state is what authorizes it). Scope drive.appdata: a private app folder
 * in the user's Drive that nothing else can see or touch.
 *
 * Credentials live in sync-auth.json next to auth.json (mode 0600), not in
 * auth.json, whose values are reflected into the process environment.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTH_FILE } from "../../../config.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import type { Remote, RemoteFile } from "./engine.ts";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const CALLBACK_PATH = "/oauth/google/callback";

export type SyncCredentials = {
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	email?: string;
	/** Automatic sync (on by default once connected). */
	auto?: boolean;
	lastSync?: string;
	lastError?: string;
};

const credFile = () => path.join(path.dirname(AUTH_FILE), "sync-auth.json");

export function readCredentials(): SyncCredentials {
	try {
		const raw = JSON.parse(fs.readFileSync(credFile(), "utf-8")) as unknown;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SyncCredentials) : {};
	} catch {
		return {};
	}
}

export function writeCredentials(patch: Partial<SyncCredentials>): SyncCredentials {
	const next = { ...readCredentials(), ...patch };
	for (const key of Object.keys(next) as (keyof SyncCredentials)[]) if (next[key] === undefined) delete next[key];
	fs.mkdirSync(path.dirname(credFile()), { recursive: true });
	writeFileAtomicSync(credFile(), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
	return next;
}

// ─── sign-in ────────────────────────────────────────────────────────────────

type Pending = { verifier: string; redirectUri: string; expires: number };
const pendingKey = "__lhGoogleSyncPending";
function pending(): Map<string, Pending> {
	const g = globalThis as typeof globalThis & { [pendingKey]?: Map<string, Pending> };
	return (g[pendingKey] ??= new Map());
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The Google consent URL; `origin` is this server as the browser sees it. */
export function beginSignIn(origin: string): string {
	const { clientId } = readCredentials();
	if (!clientId) throw new Error("Add your Google OAuth client ID first");
	const state = b64url(randomBytes(24));
	const verifier = b64url(randomBytes(48));
	const redirectUri = `${origin}${CALLBACK_PATH}`;
	const now = Date.now();
	for (const [k, p] of pending()) if (p.expires < now) pending().delete(k);
	pending().set(state, { verifier, redirectUri, expires: now + 10 * 60_000 });
	const url = new URL(AUTH_URL);
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: `${SCOPE} openid email`,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: b64url(createHash("sha256").update(verifier).digest()),
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

/** The callback: trade the code for a refresh token. Throws a user-facing message. */
export async function finishSignIn(state: string, code: string): Promise<void> {
	const p = pending().get(state);
	pending().delete(state);
	if (!p || p.expires < Date.now()) throw new Error("This sign-in link expired. Start again from LearnHarness.");
	const { clientId, clientSecret } = readCredentials();
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId ?? "",
			client_secret: clientSecret ?? "",
			redirect_uri: p.redirectUri,
			grant_type: "authorization_code",
			code_verifier: p.verifier,
		}),
	});
	const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; id_token?: string; error_description?: string; error?: string };
	if (!res.ok || !body.refresh_token) throw new Error(body.error_description ?? body.error ?? `Google sign-in failed (${res.status})`);
	let email: string | undefined;
	try {
		const payload = JSON.parse(Buffer.from((body.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf-8")) as { email?: string };
		email = payload.email;
	} catch { /* no email claim */ }
	writeCredentials({ refreshToken: body.refresh_token, email, auto: readCredentials().auto ?? true, lastError: undefined });
}

export function signOut(): void {
	writeCredentials({ refreshToken: undefined, email: undefined, lastSync: undefined, lastError: undefined });
}

// ─── Drive ──────────────────────────────────────────────────────────────────

let cachedToken: { value: string; expires: number; refresh: string } | null = null;

async function accessToken(): Promise<string> {
	const { clientId, clientSecret, refreshToken } = readCredentials();
	if (!refreshToken) throw new Error("Not signed in to Google");
	if (cachedToken && cachedToken.refresh === refreshToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId ?? "", client_secret: clientSecret ?? "", refresh_token: refreshToken, grant_type: "refresh_token" }),
	});
	const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
	if (!res.ok || !body.access_token) {
		if (body.error === "invalid_grant") throw new Error("Google sign-in expired. Connect again in Settings → Sync.");
		throw new Error(body.error_description ?? body.error ?? `Google token refresh failed (${res.status})`);
	}
	cachedToken = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000, refresh: refreshToken };
	return body.access_token;
}

async function drive(url: string, init: RequestInit = {}): Promise<Response> {
	const token = await accessToken();
	const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		let message = `Google Drive error ${res.status}`;
		try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
		throw new Error(message);
	}
	return res;
}

type DriveFile = { id: string; name: string; md5Checksum?: string; modifiedTime: string; appProperties?: { lhPath?: string } };
const FIELDS = "id,name,md5Checksum,modifiedTime,appProperties";
const toRemote = (f: DriveFile): RemoteFile => ({ id: f.id, path: f.appProperties?.lhPath ?? f.name, md5: f.md5Checksum ?? "", modifiedTime: f.modifiedTime });

export const driveRemote: Remote = {
	async list() {
		const out: RemoteFile[] = [];
		let pageToken: string | undefined;
		do {
			const q = new URLSearchParams({ spaces: "appDataFolder", pageSize: "1000", fields: `nextPageToken,files(${FIELDS})` });
			if (pageToken) q.set("pageToken", pageToken);
			const body = (await (await drive(`${DRIVE}/files?${q}`)).json()) as { files?: DriveFile[]; nextPageToken?: string };
			for (const f of body.files ?? []) out.push(toRemote(f));
			pageToken = body.nextPageToken;
		} while (pageToken);
		return out;
	},
	async download(file) {
		return Buffer.from(await (await drive(`${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media`)).arrayBuffer());
	},
	async upload(rel, body, id) {
		if (id) {
			const res = await drive(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`, {
				method: "PATCH",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(body),
			});
			return toRemote((await res.json()) as DriveFile);
		}
		const boundary = `lh${randomBytes(12).toString("hex")}`;
		const meta = JSON.stringify({ name: rel, parents: ["appDataFolder"], appProperties: { lhPath: rel } });
		const multipart = Buffer.concat([
			Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
			body,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);
		const res = await drive(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
			method: "POST",
			headers: { "content-type": `multipart/related; boundary=${boundary}` },
			body: new Uint8Array(multipart),
		});
		return toRemote((await res.json()) as DriveFile);
	},
	async remove(file) {
		await drive(`${DRIVE}/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
	},
};
