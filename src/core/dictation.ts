/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}

/** Where dictated audio is transcribed. Deepgram streams to the cloud with a
 * key; Whisper runs on this machine (no key, no network after the one-time
 * model download); the endpoint is any OpenAI-compatible
 * /v1/audio/transcriptions server (whisper.cpp, speaches, LocalAI, …). */
export const DICTATION_ENGINES = ["deepgram", "whisper", "endpoint"] as const;
export type DictationEngine = (typeof DICTATION_ENGINES)[number];

export const DICTATION_ENGINE_LABELS: Record<DictationEngine, string> = {
	deepgram: "Deepgram (cloud)",
	whisper: "Whisper (on this device)",
	endpoint: "Transcription endpoint",
};

export function isDictationEngine(value: unknown): value is DictationEngine {
	return DICTATION_ENGINES.includes(value as DictationEngine);
}

/** Local Whisper checkpoints (ONNX exports run by transformers.js). The
 * decoder is always 8-bit; the small checkpoints keep a full-precision
 * encoder (an 8-bit tiny encoder turned clear speech into nonsense in
 * testing), the large one quantizes it (2.5 GB → 650 MB). Sizes are the
 * one-time download. */
export const WHISPER_MODELS = [
	{ id: "onnx-community/whisper-tiny", label: "Tiny", size: "~65 MB", encoder: "fp32" },
	{ id: "onnx-community/whisper-base", label: "Base", size: "~140 MB", encoder: "fp32" },
	{ id: "onnx-community/whisper-small", label: "Small", size: "~510 MB", encoder: "fp32" },
	{ id: "onnx-community/whisper-large-v3-turbo", label: "Large v3 Turbo", size: "~1.1 GB", encoder: "q8" },
] as const;
export type WhisperModelId = (typeof WHISPER_MODELS)[number]["id"];

export function isWhisperModel(value: unknown): value is WhisperModelId {
	return WHISPER_MODELS.some(({ id }) => id === value);
}

/** Whisper takes bare ISO 639-1 codes. Multilingual sends none: endpoints
 * auto-detect, while local transformers.js Whisper falls back to English. */
export function whisperLanguage(language: DictationLanguage): string | undefined {
	if (language === "multi") return undefined;
	return (language.split("-")[0] ?? language).toLowerCase();
}

/** A transcription endpoint URL: http(s) only. */
export function isTranscriptionEndpointUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Accept a base URL (http://localhost:8000/v1) or the full route. */
export function transcriptionsUrl(endpoint: string): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	return /\/audio\/transcriptions$/.test(trimmed) ? trimmed : `${trimmed}/audio/transcriptions`;
}
