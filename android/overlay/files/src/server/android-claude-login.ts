/**
 * Android build only (android/overlay): sign the bundled Claude Code CLI in
 * with a Claude subscription from inside the app. `claude auth login` prints
 * an authorize URL and then reads the code the browser shows; the app opens
 * the URL in the phone's browser and the learner pastes the code back.
 * Credentials stay where the CLI keeps them, under the app's private HOME.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../core/auth-env.ts";
import { claudeSpawnSpec, getClaudeBinary } from "../agent/claude-code/binary.ts";

export type ClaudeAuthStatus = { loggedIn: boolean; method: string | null; email: string | null };

let login: { child: ChildProcessWithoutNullStreams; output: string } | null = null;

function binaryOrThrow(): string {
	const binary = getClaudeBinary();
	if (!binary) throw new Error("The bundled Claude Code CLI is missing");
	return binary;
}

function stopLogin() {
	login?.child.kill("SIGKILL");
	login = null;
}

export function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
	const spec = claudeSpawnSpec(binaryOrThrow(), ["auth", "status"]);
	return new Promise((resolve) => {
		execFile(spec.command, spec.args, { cwd: tmpdir(), env: externalCliEnv(), timeout: 15_000, maxBuffer: 65_536 }, (_error, stdout) => {
			try {
				const s = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
				resolve({
					loggedIn: s.loggedIn === true,
					method: typeof s.authMethod === "string" ? s.authMethod : null,
					email: typeof s.email === "string" ? s.email : null,
				});
			} catch {
				resolve({ loggedIn: false, method: null, email: null });
			}
		});
	});
}

/** Start a fresh login; resolves with the authorize URL to open. */
export function startClaudeLogin(): Promise<string> {
	stopLogin();
	const spec = claudeSpawnSpec(binaryOrThrow(), ["auth", "login", "--claudeai"]);
	const child = spawn(spec.command, spec.args, {
		cwd: tmpdir(),
		// No browser can be opened from the server process; the app opens the URL.
		env: { ...externalCliEnv(), BROWSER: "/nonexistent" },
		stdio: "pipe",
	});
	const current = { child, output: "" };
	login = current;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { stopLogin(); reject(new Error("Claude Code did not start the sign-in")); }, 30_000);
		const onData = (buf: Buffer) => {
			current.output += buf.toString();
			const url = /https:\/\/\S+oauth\/authorize\?\S+/.exec(current.output)?.[0];
			if (url) { clearTimeout(timer); resolve(url); }
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", () => {
			if (login === current) login = null;
			clearTimeout(timer);
			reject(new Error("Claude Code exited before showing a sign-in link"));
		});
	});
}

/** Hand the browser's code to the waiting login. */
export function finishClaudeLogin(code: string): Promise<ClaudeAuthStatus> {
	const current = login;
	if (!current) return Promise.reject(new Error("Start the sign-in again; it expired"));
	const before = current.output.length;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { stopLogin(); reject(new Error("Claude Code did not finish signing in")); }, 60_000);
		current.child.on("exit", async () => {
			clearTimeout(timer);
			if (login === current) login = null;
			const status = await claudeAuthStatus();
			if (status.loggedIn) resolve(status);
			else {
				const said = current.output.slice(before).replace(/\s+/g, " ").trim().slice(0, 200);
				reject(new Error(said || "Sign-in failed"));
			}
		});
		current.child.stdin.write(code.trim() + "\n");
	});
}

export function claudeLogout(): Promise<void> {
	stopLogin();
	const spec = claudeSpawnSpec(binaryOrThrow(), ["auth", "logout"]);
	return new Promise((resolve) => {
		execFile(spec.command, spec.args, { cwd: tmpdir(), env: externalCliEnv(), timeout: 15_000 }, () => resolve());
	});
}
