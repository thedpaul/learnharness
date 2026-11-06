"use client";

/**
 * Sound cues: the mic opening and closing for dictation, and a graded quiz
 * answer (correct / wrong). Synthesized with Web Audio — no audio assets —
 * short and quiet. On by default; the switch (Settings → Appearance) is
 * stored on this device, since sound is a per-device choice.
 */

export type SoundCue = "mic-on" | "mic-off" | "correct" | "wrong";

const STORAGE_KEY = "lh:sound-effects";

export function soundEffectsEnabled(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setSoundEffectsEnabled(on: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
	} catch {
		/* storage unavailable: the cue stays at its default */
	}
}

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
	if (typeof window === "undefined" || !("AudioContext" in window)) return null;
	ctx ??= new AudioContext();
	if (ctx.state === "suspended") void ctx.resume();
	return ctx;
}

/** One enveloped note: quick attack, exponential decay. */
function note(ac: AudioContext, freq: number, at: number, length: number, peak: number, type: OscillatorType): void {
	const osc = ac.createOscillator();
	const gain = ac.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, at);
	gain.gain.setValueAtTime(0.0001, at);
	gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
	osc.connect(gain).connect(ac.destination);
	osc.start(at);
	osc.stop(at + length + 0.02);
}

export function playCue(cue: SoundCue): void {
	if (!soundEffectsEnabled()) return;
	// A cue must never break what triggered it (dictation, a submit).
	try {
		play(cue);
	} catch {
		/* no usable audio output */
	}
}

function play(cue: SoundCue): void {
	const ac = audio();
	if (!ac || typeof ac.createOscillator !== "function") return;
	const t = ac.currentTime + 0.01;
	switch (cue) {
		case "mic-on": // rising blip
			note(ac, 660, t, 0.09, 0.07, "sine");
			note(ac, 990, t + 0.07, 0.12, 0.07, "sine");
			break;
		case "mic-off": // falling blip
			note(ac, 990, t, 0.09, 0.06, "sine");
			note(ac, 660, t + 0.07, 0.12, 0.06, "sine");
			break;
		case "correct": // bright major arpeggio
			note(ac, 1046.5, t, 0.18, 0.08, "triangle");
			note(ac, 1318.5, t + 0.08, 0.18, 0.08, "triangle");
			note(ac, 1568, t + 0.16, 0.4, 0.09, "triangle");
			break;
		case "wrong": // soft low two-step down
			note(ac, 311, t, 0.16, 0.1, "triangle");
			note(ac, 233, t + 0.14, 0.3, 0.1, "triangle");
			break;
	}
}
