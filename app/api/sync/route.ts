/** Sync: status and actions (Settings → Sync, the sync agent). Phone sync
 *  (hub-*, pair, unpair, lan-auto) is the visible flow; the Google Drive
 *  actions stay behind GOOGLE_SYNC_ENABLED. */
import { GOOGLE_SYNC_ENABLED, SYNC_ENABLED } from "@/src/core";
import {
	beginSignIn, configureSync, pairWith, renewHubSecret, setAutoSync, setHub, setLanAuto, signOut, syncNow, syncStatus, unpair,
} from "@/src/server";

export const dynamic = "force-dynamic";

const fail = (e: unknown, status = 502) => Response.json({ message: e instanceof Error ? e.message : "Sync failed" }, { status });

/** The browser must come back to THIS server on a loopback address. */
function loopbackOrigin(request: Request): string | null {
	const host = request.headers.get("host") ?? "";
	return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) ? `http://${host}` : null;
}

/** The counts only: the changed paths are for change events, not the UI. */
const summary = ({ changedLocal: _changed, ...counts }: Awaited<ReturnType<typeof syncNow>>) => counts;

const off = () => Response.json({ message: "Sync is switched off" }, { status: 404 });

export async function GET() {
	if (!SYNC_ENABLED) return off();
	return Response.json(await syncStatus());
}

export async function POST(request: Request) {
	if (!SYNC_ENABLED) return off();
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const google = new Set(["configure", "connect", "disconnect", "auto"]);
	if (!GOOGLE_SYNC_ENABLED && google.has(String(body?.action))) return off();
	try {
		switch (body?.action) {
			case "hub":
				if (typeof body.on !== "boolean") return Response.json({ message: "on must be a boolean" }, { status: 400 });
				await setHub(body.on);
				return Response.json(await syncStatus());
			case "hub-renew":
				await renewHubSecret();
				return Response.json(await syncStatus());
			case "pair": {
				if (typeof body.code !== "string" || body.code.length > 2048) return Response.json({ message: "Scan or paste the code from your computer" }, { status: 400 });
				await pairWith(body.code);
				const result = await syncNow();
				return Response.json({ ...(await syncStatus()), result: summary(result) });
			}
			case "unpair":
				unpair();
				return Response.json(await syncStatus());
			case "lan-auto":
				if (typeof body.on !== "boolean") return Response.json({ message: "on must be a boolean" }, { status: 400 });
				setLanAuto(body.on);
				return Response.json(await syncStatus());
			case "configure":
				if (typeof body.clientId !== "string" || typeof body.clientSecret !== "string" || body.clientId.length > 512 || body.clientSecret.length > 512) {
					return Response.json({ message: "Paste the client ID and secret" }, { status: 400 });
				}
				configureSync(body.clientId, body.clientSecret);
				return Response.json(await syncStatus());
			case "connect": {
				const origin = loopbackOrigin(request);
				if (!origin) return Response.json({ message: "Google sign-in needs LearnHarness on 127.0.0.1" }, { status: 400 });
				return Response.json({ url: beginSignIn(origin) });
			}
			case "disconnect":
				signOut();
				return Response.json(await syncStatus());
			case "auto":
				if (typeof body.on !== "boolean") return Response.json({ message: "on must be a boolean" }, { status: 400 });
				setAutoSync(body.on);
				return Response.json(await syncStatus());
			case "run": {
				const status = await syncStatus();
				if (!status.lan.client.paired && !(GOOGLE_SYNC_ENABLED && status.connected)) {
					return Response.json({ message: "Pair with a computer first" }, { status: 409 });
				}
				const result = await syncNow();
				return Response.json({ ...(await syncStatus()), result: summary(result) });
			}
			default:
				return Response.json({ message: "unknown action" }, { status: 400 });
		}
	} catch (e) {
		return fail(e, body?.action === "configure" || body?.action === "pair" ? 400 : 502);
	}
}
