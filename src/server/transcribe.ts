/**
 * Batch transcription for the keyless dictation engines. The renderer
 * captures the same linear16 16kHz mono PCM it streams to Deepgram, keeps
 * it for the run (dictation is deferred anyway: text lands once, at stop),
 * and POSTs it here in one go:
 *
 *   whisper   transformers.js + onnxruntime-node on this machine. The model
 *             downloads once from the Hugging Face Hub into
 *             <data>/models and every later run is fully offline.
 *   endpoint  an OpenAI-compatible /v1/audio/transcriptions server
 *             (whisper.cpp server, speaches, LocalAI, a hosted free tier…).
 *             Proxied server-side: no CORS needs on the endpoint, and its
 *             optional key (STT_ENDPOINT_API_KEY) never reaches the renderer.
 *
 * transformers.js is imported lazily: Deepgram/endpoint users never load
 * onnxruntime or its native image dependency into the server process.
 */
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	WHISPER_MODELS, transcriptionsUrl, whisperLanguage, type DictationLanguage, type WhisperModelId,
} from "../core/dictation.ts";
import { keyValue } from "./keys.ts";

export const STT_SAMPLE_RATE = 16000;
/** 15 minutes of linear16 mono — far beyond any spoken answer. */
export const MAX_DICTATION_PCM_BYTES = STT_SAMPLE_RATE * 2 * 60 * 15;

export const WHISPER_CACHE_DIR = path.join(PATHS.data, "models");

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

/** One loaded pipeline per checkpoint for the server's lifetime; a failed
 *  load (offline first run, disk full) is forgotten so the next run retries. */
const pipelines = new Map<WhisperModelId, Promise<Asr>>();

export function loadWhisper(model: WhisperModelId): Promise<Asr> {
	let p = pipelines.get(model);
	if (!p) {
		p = (async () => {
			const { pipeline, env } = await import("@huggingface/transformers");
			env.cacheDir = WHISPER_CACHE_DIR;
			const encoder = WHISPER_MODELS.find((m) => m.id === model)?.encoder ?? "fp32";
			const asr = await pipeline("automatic-speech-recognition", model, {
				dtype: { encoder_model: encoder, decoder_model_merged: "q8" },
				device: "cpu",
			});
			return asr as unknown as Asr;
		})();
		p.catch(() => { if (pipelines.get(model) === p) pipelines.delete(model); });
		pipelines.set(model, p);
	}
	return p;
}

export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
	const out = new Float32Array(view.byteLength / 2);
	for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
	return out;
}

/** Wrap raw linear16 mono PCM in a minimal RIFF/WAVE header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate = STT_SAMPLE_RATE): Uint8Array {
	const dataLen = pcm.byteLength - (pcm.byteLength % 2);
	const out = new Uint8Array(44 + dataLen);
	const v = new DataView(out.buffer);
	const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
	ascii(0, "RIFF");
	v.setUint32(4, 36 + dataLen, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true); // PCM fmt chunk size
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 2, true); // byte rate
	v.setUint16(32, 2, true); // block align
	v.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	v.setUint32(40, dataLen, true);
	out.set(pcm.subarray(0, dataLen), 44);
	return out;
}

/** Whisper hallucinates captions over silence ("[BLANK_AUDIO]", "(music)");
 *  bracketed non-speech tags never belong in the learner's answer. */
export function cleanTranscript(text: string): string {
	return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

export async function transcribeWithWhisper(
	pcm: Uint8Array, model: WhisperModelId, language: DictationLanguage,
): Promise<string> {
	const audio = pcm16ToFloat32(pcm);
	if (audio.length === 0) return "";
	const asr = await loadWhisper(model);
	const lang = whisperLanguage(language);
	const result = await asr(audio, {
		task: "transcribe",
		...(lang ? { language: lang } : {}),
		// Long dictations: 30s windows with overlap, stitched by the pipeline.
		chunk_length_s: 30,
		stride_length_s: 5,
	});
	const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
	return cleanTranscript(text);
}

export async function transcribeWithEndpoint(
	pcm: Uint8Array,
	endpoint: { url: string; model: string },
	language: DictationLanguage,
	request: typeof fetch = fetch,
): Promise<string> {
	if (pcm.byteLength < 2) return "";
	const form = new FormData();
	form.append("file", new Blob([pcm16ToWav(pcm) as BlobPart], { type: "audio/wav" }), "dictation.wav");
	form.append("model", endpoint.model);
	form.append("response_format", "json");
	const lang = whisperLanguage(language);
	if (lang) form.append("language", lang);
	const key = keyValue("STT_ENDPOINT_API_KEY");
	const res = await request(transcriptionsUrl(endpoint.url), {
		method: "POST",
		headers: key ? { Authorization: `Bearer ${key}` } : {},
		body: form,
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 200);
		throw new Error(`Transcription endpoint failed (${res.status})${detail ? `: ${detail}` : ""}`);
	}
	const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
	if (typeof body?.text !== "string") throw new Error("Transcription endpoint returned no text");
	return cleanTranscript(body.text);
}
