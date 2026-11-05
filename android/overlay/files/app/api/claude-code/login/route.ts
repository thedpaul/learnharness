/** Android build only: in-app Claude subscription sign-in for the bundled CLI. */
import { claudeAuthStatus, claudeLogout, finishClaudeLogin, startClaudeLogin } from "@/src/server";

export const dynamic = "force-dynamic";

const fail = (e: unknown) => Response.json({ message: e instanceof Error ? e.message : "Claude Code sign-in failed" }, { status: 502 });

export async function GET() {
	try { return Response.json(await claudeAuthStatus()); } catch (e) { return fail(e); }
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { action?: unknown; code?: unknown } | null;
	try {
		switch (body?.action) {
			case "start": return Response.json({ url: await startClaudeLogin() });
			case "code":
				if (typeof body.code !== "string" || !body.code.trim() || body.code.length > 4096) {
					return Response.json({ message: "Paste the code from the browser" }, { status: 400 });
				}
				return Response.json(await finishClaudeLogin(body.code));
			case "logout": await claudeLogout(); return Response.json(await claudeAuthStatus());
			default: return Response.json({ message: "unknown action" }, { status: 400 });
		}
	} catch (e) {
		return fail(e);
	}
}
