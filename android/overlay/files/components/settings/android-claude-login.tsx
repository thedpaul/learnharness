"use client";
/** Android build only: sign the bundled Claude Code CLI in with a Claude
 *  subscription (Pro/Max). Replaces the desktop "authenticate in your
 *  terminal" instruction — a phone has no terminal. */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Status = { loggedIn: boolean; method: string | null; email: string | null };

async function call(body?: object): Promise<Record<string, unknown>> {
	const res = await fetch("/api/claude-code/login", body
		? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
		: { cache: "no-store" });
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : `HTTP ${res.status}`);
	return data;
}

export function AndroidClaudeLogin() {
	const [status, setStatus] = useState<Status | null>(null);
	const [url, setUrl] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = useCallback(async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
	}, []);
	useEffect(() => { void run(async () => setStatus(await call() as Status)); }, [run]);

	if (status?.loggedIn) {
		return <div className="flex flex-wrap items-center gap-3" data-testid="android-claude-login">
			<span role="status" className="text-xs text-muted-foreground">Signed in{status.email ? ` as ${status.email}` : ""}</span>
			<Button type="button" size="xs" variant="outline" disabled={busy}
				onClick={() => void run(async () => setStatus(await call({ action: "logout" }) as Status))}>Sign out</Button>
			{error && <p role="alert" className="w-full text-xs text-red-400">{error}</p>}
		</div>;
	}

	return <div className="space-y-2" data-testid="android-claude-login">
		<p className="text-xs leading-relaxed text-muted-foreground">
			<strong className="font-medium">Sign in with your Claude subscription</strong> to use Claude Code models here. Claude Code is bundled with this app.
		</p>
		{!url ? <Button type="button" size="xs" variant="outline" disabled={busy || status === null}
			onClick={() => void run(async () => setUrl((await call({ action: "start" })).url as string))}>
			{busy ? "Starting…" : "Sign in with Claude"}
		</Button> : <>
			<p className="text-xs leading-relaxed text-muted-foreground">
				1. <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Open the Claude sign-in page ↗</a> and approve access.<br />
				2. Copy the code it shows and paste it here.
			</p>
			<div className="flex items-center gap-2">
				<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste code"
					aria-label="Claude sign-in code" autoComplete="off" spellCheck={false}
					className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none" />
				<Button type="button" size="xs" variant="outline" disabled={busy || !code.trim()}
					onClick={() => void run(async () => { setStatus(await call({ action: "code", code }) as Status); setUrl(null); setCode(""); })}>
					{busy ? "Signing in…" : "Finish"}
				</Button>
			</div>
			<Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { setUrl(null); setCode(""); }}>Cancel</Button>
		</>}
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
	</div>;
}
