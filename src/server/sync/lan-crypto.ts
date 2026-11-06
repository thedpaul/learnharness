/**
 * Phone sync over the local network: the pairing code and the sealed
 * request/response bodies (lan-hub.ts serves, http-remote.ts calls).
 *
 * The QR code carries a 32-byte random secret; nothing else authorizes a
 * request. Every body is AES-256-GCM sealed with a key derived from it, so
 * plain HTTP on the Wi-Fi is fine: nothing readable crosses it and nothing
 * forged opens. The request's timestamp is bound in as associated data and
 * the hub refuses stale timestamps and repeated IVs (replays); a response is
 * bound to the request IV it answers.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const LAN_DEFAULT_PORT = 47321;
/** A request older or newer than this is refused (clock skew + transit). */
export const LAN_WINDOW_MS = 5 * 60_000;

const PREFIX = "lhsync:1:";
const IV = 12;
const TAG = 16;

export type PairCode = { hosts: string[]; port: number; secret: Buffer };

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function newSecret(): Buffer {
	return randomBytes(32);
}

/** `lhsync:1:<host,host>:<port>:<secret>` — what the QR code holds. */
export function encodePairCode(code: PairCode): string {
	return `${PREFIX}${code.hosts.join(",")}:${code.port}:${b64url(code.secret)}`;
}

export function decodePairCode(text: string): PairCode | null {
	const t = text.trim();
	if (!t.startsWith(PREFIX)) return null;
	const [hosts, port, secret] = t.slice(PREFIX.length).split(":");
	if (!hosts || !port || !secret) return null;
	const list = hosts.split(",").filter((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
	const p = Number(port);
	const key = Buffer.from(secret, "base64url");
	if (list.length === 0 || !Number.isInteger(p) || p < 1 || p > 65535 || key.length !== 32) return null;
	return { hosts: list, port: p, secret: key };
}

export function lanKey(secret: Buffer): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, "learnharness-lan-sync", "aes-256-gcm", 32));
}

/** iv | ciphertext | tag */
export function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
	const iv = randomBytes(IV);
	const c = createCipheriv("aes-256-gcm", key, iv);
	c.setAAD(Buffer.from(aad));
	const body = Buffer.concat([c.update(plain), c.final()]);
	return Buffer.concat([iv, body, c.getAuthTag()]);
}

/** Throws on a wrong key, a tampered body or a different `aad`. */
export function unseal(key: Buffer, sealed: Buffer, aad: string): Buffer {
	if (sealed.length < IV + TAG) throw new Error("sealed body too short");
	const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV));
	d.setAAD(Buffer.from(aad));
	d.setAuthTag(sealed.subarray(sealed.length - TAG));
	return Buffer.concat([d.update(sealed.subarray(IV, sealed.length - TAG)), d.final()]);
}

export const ivOf = (sealed: Buffer) => sealed.subarray(0, IV).toString("hex");
export const requestAad = (ts: string) => `req:${ts}`;
export const responseAad = (requestIv: string) => `res:${requestIv}`;
