"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRightIcon } from "lucide-react";
import type { ArtifactPartProps } from "@/src/core";
import { stashOpeningPrompt } from "@/components/opening-prompt";

interface StartSessionOutput {
	ok?: boolean;
	id?: unknown;
	title?: unknown;
	message?: unknown;
	error?: unknown;
}

/** A valid start_session result, or null (a refusal, a malformed id). */
export function startedSession(output: unknown): { id: string; title: string; message: string } | null {
	const out = (output ?? {}) as StartSessionOutput;
	if (out.ok !== true || typeof out.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(out.id)) return null;
	return {
		id: out.id,
		title: typeof out.title === "string" ? out.title : "New session",
		message: typeof out.message === "string" ? out.message : "",
	};
}

/**
 * The start_session card (owner, 2026-11-07): an unrelated topic opened a
 * separate session. When the result arrives LIVE (this mount saw the call
 * before its output), the app switches to the new session with the
 * learner's request waiting in the composer — stashed as an attempted
 * opening prompt, so the new session restores it as a draft and never
 * sends it on its own. A transcript replay (reload, another device) only
 * shows the card with its Open link.
 */
export function StartSessionCard({ part }: ArtifactPartProps) {
	const router = useRouter();
	const session = part.state === "output-available" ? startedSession(part.output) : null;
	const sawLive = useRef(part.state !== "output-available");
	const switched = useRef(false);

	useEffect(() => {
		if (!session || !sawLive.current || switched.current) return;
		switched.current = true;
		if (session.message) stashOpeningPrompt(session.id, session.message, true);
		router.push(`/chat/${session.id}`);
	}, [session, router]);

	if (!session) return null;
	const open = () => {
		if (session.message) stashOpeningPrompt(session.id, session.message, true);
		router.push(`/chat/${session.id}`);
	};
	return (
		<button
			type="button"
			data-testid="start-session-card"
			onClick={open}
			className="my-3 flex w-full items-center gap-2 rounded-xl border bg-card/60 px-3 py-2 text-left text-sm hover:bg-muted/60"
		>
			<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">New session</span>
			<span className="min-w-0 flex-1 truncate">{session.title}</span>
			<ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
		</button>
	);
}
