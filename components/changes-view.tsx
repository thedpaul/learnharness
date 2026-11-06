"use client";

/**
 * The Changes page (src/server/changes.ts): session questions a later check
 * flagged and graph facts the recheck corrected, newest first. What was
 * unseen when the page opened keeps its "!" for this visit; opening the
 * page marks it seen.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { markChangesSeen, useChanges, type Change } from "@/components/changes";
import { TopBar } from "@/components/top-bar";

const when = (at: string) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function NewMark() {
	return (
		<span aria-label="new" className="flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-500 font-bold text-[0.65rem] text-black">
			!
		</span>
	);
}

export function ChangesView() {
	const items = useChanges();
	const [fresh, setFresh] = useState<Set<string> | null>(null);
	const marked = useRef(false);
	useEffect(() => {
		if (!items || marked.current) return;
		marked.current = true;
		const unseen = items.filter((c) => !c.seen).map((c) => c.id);
		setFresh(new Set(unseen));
		markChangesSeen(unseen);
	}, [items]);
	const isNew = (c: Change) => fresh?.has(c.id) ?? !c.seen;

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar>
				<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Changes</span>
				<div className="min-w-4 flex-1" />
				{items && (
					<span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground" data-testid="changes-counts">
						{fresh?.size ? `${fresh.size} new · ` : ""}
						{items.length} total
					</span>
				)}
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6">
					<p className="text-sm text-muted-foreground">
						What later checks found: questions from your sessions with a wrong answer key or unclear wording (kept out of reviews and
						calibration), and graph facts that were corrected.
					</p>
					{!items && <p className="text-sm text-muted-foreground">Loading…</p>}
					{items?.length === 0 && (
						<p className="py-6 text-center text-sm text-muted-foreground" data-testid="changes-empty">
							Nothing yet. Findings from card checks and fact rechecks show up here.
						</p>
					)}
					{items?.map((c) => (
						<div key={c.id} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground" data-testid="change-item">
							<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
								{isNew(c) && <NewMark />}
								<span>{c.kind === "card" ? (c.verdict === "wrong" ? "Wrong answer key" : "Unclear question") : "Fact corrected"}</span>
								<span className="ml-auto font-mono normal-case tracking-normal">{when(c.at)}</span>
							</div>
							{c.kind === "card" ? (
								<>
									<div className="lh-prose text-sm">
										<ToolContentResponse>{c.questionText}</ToolContentResponse>
									</div>
									{c.reason && <p className="text-xs text-muted-foreground">{c.reason}</p>}
									<Link href={`/chat/${encodeURIComponent(c.chatId)}`} className="self-start text-xs underline underline-offset-2 hover:text-foreground">
										In {c.chatTitle}
									</Link>
								</>
							) : (
								<>
									<div className="text-sm font-medium">{c.name}</div>
									<div className="lh-prose text-sm text-muted-foreground line-through decoration-muted-foreground/60">
										<ToolContentResponse>{c.was}</ToolContentResponse>
									</div>
									<div className="lh-prose text-sm">
										<ToolContentResponse>{c.statement}</ToolContentResponse>
									</div>
									{c.reason && <p className="text-xs text-muted-foreground">{c.reason}</p>}
								</>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
