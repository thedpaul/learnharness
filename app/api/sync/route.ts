/** Google Drive sync: status and actions (Settings → Sync, the sync agent). */
import { beginSignIn, configureSync, setAutoSync, signOut, syncNow, syncStatus } from "@/src/server";

export const dynamic = "force-dynamic";

const fail = (e: unknown, status = 502) => Response.json({ message: e instanceof Error ? e.message : "Sync failed" }, { status });

/** The browser must come back to THIS server on a loopback address. */
function loopbackOrigin(request: Request): string | null {
	const host = request.headers.get("host") ?? "";
	return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) ? `http://${host}` : null;
}

export async function GET() {
	return Response.json(syncStatus());
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	try {
		switch (body?.action) {
			case "configure":
				if (typeof body.clientId !== "string" || typeof body.clientSecret !== "string" || body.clientId.length > 512 || body.clientSecret.length > 512) {
					return Response.json({ message: "Paste the client ID and secret" }, { status: 400 });
				}
				configureSync(body.clientId, body.clientSecret);
				return Response.json(syncStatus());
			case "connect": {
				const origin = loopbackOrigin(request);
				if (!origin) return Response.json({ message: "Google sign-in needs LearnHarness on 127.0.0.1" }, { status: 400 });
				return Response.json({ url: beginSignIn(origin) });
			}
			case "disconnect":
				signOut();
				return Response.json(syncStatus());
			case "auto":
				if (typeof body.on !== "boolean") return Response.json({ message: "on must be a boolean" }, { status: 400 });
				setAutoSync(body.on);
				return Response.json(syncStatus());
			case "run": {
				if (!syncStatus().connected) return Response.json({ message: "Not connected to Google Drive" }, { status: 409 });
				const result = await syncNow();
				return Response.json({ ...syncStatus(), result });
			}
			default:
				return Response.json({ message: "unknown action" }, { status: 400 });
		}
	} catch (e) {
		return fail(e, body?.action === "configure" ? 400 : 502);
	}
}
