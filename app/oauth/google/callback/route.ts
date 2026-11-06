/**
 * Google's redirect after the sync sign-in (src/server/sync/google.ts). It
 * sits outside /api on purpose: the user's browser carries no app
 * capability; the one-time `state` from beginSignIn is the authorization.
 */
import { SYNC_ENABLED } from "@/src/core";
import { finishSignIn } from "@/src/server";

export const dynamic = "force-dynamic";

function page(title: string, detail: string, status = 200): Response {
	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141414;color:#ddd;font:15px/1.5 system-ui,sans-serif}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.2rem;color:#fff}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`;
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export async function GET(request: Request) {
	if (!SYNC_ENABLED) return page("Sync is switched off", "Google Drive sync isn't available in this version.", 404);
	const url = new URL(request.url);
	const error = url.searchParams.get("error");
	if (error) return page("Google sign-in was cancelled", "You can close this tab and try again from LearnHarness.", 400);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	if (!state || !code) return page("Sign-in incomplete", "Start the Google sign-in again from LearnHarness.", 400);
	try {
		await finishSignIn(state, code);
		return page("Google Drive connected", "You can close this tab and go back to LearnHarness.");
	} catch (e) {
		return page("Google sign-in failed", e instanceof Error ? e.message : "Try again from LearnHarness.", 400);
	}
}
