/**
 * The keyless dictation engines (src/server/transcribe.ts).
 *
 *   POST  body = the run's raw linear16 16kHz mono PCM
 *         → { text } transcribed by the configured engine.
 *   GET   warm-up: start loading (and on first use, downloading) the local
 *         Whisper model so the first stop doesn't pay for it. → { ready }
 *
 * Engine, model, endpoint and language come from the settings record, read
 * fresh per request — the renderer sends audio only.
 */
import {
	MAX_DICTATION_PCM_BYTES, effectiveSettings, loadWhisper, transcribeWithEndpoint, transcribeWithWhisper,
} from "@/src/server";

export const dynamic = "force-dynamic";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export async function GET() {
	const { engine, whisperModel } = effectiveSettings().dictation;
	if (engine !== "whisper") return Response.json({ ready: true });
	try {
		await loadWhisper(whisperModel);
		return Response.json({ ready: true });
	} catch (e) {
		return Response.json({ message: `Whisper model unavailable: ${message(e, "load failed")}` }, { status: 502 });
	}
}

export async function POST(request: Request) {
	const { engine, language, whisperModel, endpointUrl, endpointModel } = effectiveSettings().dictation;
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_DICTATION_PCM_BYTES) {
		return Response.json({ message: "Dictation too long to transcribe" }, { status: 413 });
	}
	const pcm = new Uint8Array(await request.arrayBuffer());
	if (pcm.byteLength > MAX_DICTATION_PCM_BYTES) {
		return Response.json({ message: "Dictation too long to transcribe" }, { status: 413 });
	}

	if (engine === "whisper") {
		try {
			return Response.json({ text: await transcribeWithWhisper(pcm, whisperModel, language) });
		} catch (e) {
			return Response.json({ message: `Whisper failed: ${message(e, "transcription error")}` }, { status: 502 });
		}
	}
	if (engine === "endpoint") {
		if (!endpointUrl) {
			return Response.json({ message: "Dictation needs a transcription endpoint URL" }, { status: 503 });
		}
		try {
			return Response.json({ text: await transcribeWithEndpoint(pcm, { url: endpointUrl, model: endpointModel }, language) });
		} catch (e) {
			return Response.json({ message: message(e, "Transcription endpoint unreachable") }, { status: 502 });
		}
	}
	return Response.json({ message: "Deepgram dictation streams directly; this route serves the local engines" }, { status: 400 });
}
