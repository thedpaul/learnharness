/**
 * The phone's side of phone sync: sealed calls to the desktop's hub
 * (lan-hub.ts), and a sync Remote on top of them for the engine.
 */
import type { Remote, RemoteFile } from "./engine.ts";
import { ivOf, lanKey, requestAad, responseAad, seal, unseal } from "./lan-crypto.ts";

export type LanCall = (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

export class HubUnreachable extends Error {}

/** `base` like http://192.168.1.20:47321 */
export function lanClient(base: string, secret: Buffer, device: string, now: () => number = Date.now): LanCall {
	const key = lanKey(secret);
	return async (op, args = {}, timeoutMs = 60_000) => {
		const ts = String(now());
		const body = seal(key, Buffer.from(JSON.stringify({ ...args, op, device })), requestAad(ts));
		let res: Response;
		try {
			res = await fetch(`${base}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream", "x-lh-ts": ts },
				body: new Uint8Array(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			throw new HubUnreachable(err instanceof Error ? err.message : String(err));
		}
		if (res.status === 401) throw new Error("The computer didn't accept this phone: pair again with its current code");
		if (res.status === 404) throw new HubUnreachable("not a LearnHarness computer");
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(unseal(key, Buffer.from(await res.arrayBuffer()), responseAad(ivOf(body))).toString("utf-8")) as Record<string, unknown>;
		} catch {
			throw new Error("The computer's reply couldn't be verified");
		}
		if (!res.ok) throw new Error(typeof value.error === "string" ? value.error : `Sync failed (${res.status})`);
		return value;
	};
}

export function httpRemote(call: LanCall): Remote {
	return {
		async list() {
			return (await call("list")).files as RemoteFile[];
		},
		async download(file) {
			return Buffer.from((await call("download", { path: file.path })).body as string, "base64");
		},
		async upload(path, body) {
			return (await call("upload", { path, body: body.toString("base64") })).file as RemoteFile;
		},
		async remove(file) {
			await call("remove", { path: file.path });
		},
	};
}
