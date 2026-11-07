import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";

/** The composition root's session factory (server/chats.ts createSession):
 *  the agent layer never imports the server, so the record + model stamp
 *  arrive as a seam. */
export interface StartSessionContext {
	kind: "teach" | "practice";
	createSession: (title: string, kind?: "practice") => { id: string; title: string };
}

/** What the view and the client card read from the call's output. */
export interface StartSessionOutput {
	ok: true;
	id: string;
	title: string;
	/** The learner's request, prefilled in the new session's composer. */
	message: string;
	note: string;
}

const startSessionInput = Type.Object({
	topic: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "A short title for the new session's subject, e.g. \"Fourier transforms\".",
	}),
	message: Type.String({
		minLength: 1,
		pattern: "\\S",
		description:
			"The learner's request for the new topic, written in the learner's own voice (first person), ready to send as the new session's opening message.",
	}),
});

/** Open a separate session for an unrelated topic (owner, 2026-11-07): the
 *  app switches the learner to it with `message` waiting in the composer —
 *  the learner presses Send; nothing posts on their behalf. The new session
 *  keeps this one's kind. One per turn. */
export function startSessionTool(ctx: StartSessionContext): AgentTool<typeof startSessionInput> {
	let started: StartSessionOutput | undefined;
	return {
		name: "start_session",
		label: "start_session",
		description:
			"Open a SEPARATE new session when the learner asks to learn something unrelated to this session's subject. " +
			"The app switches the learner to it with your `message` prefilled for them to send; this session stays as it is. " +
			"Not for prerequisites, applications or neighbouring ideas that serve this session's goal — those stay here. " +
			"After it succeeds, say one short line about the switch and END YOUR TURN.",
		parameters: startSessionInput,
		executionMode: "sequential",
		execute: serverExecute("start_session", startSessionInput, ({ topic, message }) => {
			if (started) return { ok: false, error: `A new session was already started this turn ("${started.title}").` };
			const chat = ctx.createSession(topic.trim(), ctx.kind === "practice" ? "practice" : undefined);
			started = {
				ok: true,
				id: chat.id,
				title: chat.title,
				message: message.trim(),
				note: "The learner is being switched to the new session with the message ready to send. Say one short line, then end your turn.",
			};
			return started;
		}),
	};
}
