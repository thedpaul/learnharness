package com.learnharness.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * The "android" dictation engine: Android's SpeechRecognizer, exposed to the
 * web UI as window.LHAndroidSpeech. A recognizer session ends after each
 * pause, so a run restarts it until the learner presses Stop; every final
 * result is sent to the page, which inserts the whole transcript at the end
 * (the same deferred behavior as the desktop engines).
 *
 * Tries, in order: the on-device recognizer (Android 12+), the phone's
 * default recognition service (network allowed), and that service in the
 * phone's own language. Recognizers want a regional tag ("en-US"), so a
 * bare language code from the settings is expanded first.
 */
final class SpeechBridge implements RecognitionListener {
	static final int REQUEST_MIC = 41;

	private final MainActivity activity;
	private final WebView web;
	private final Handler main = new Handler(Looper.getMainLooper());
	private SpeechRecognizer recognizer;
	private boolean active;
	private boolean stopping;
	private boolean listening;
	private boolean onDevice;
	/** 0 = on-device, 1 = default service, 2 = default service in the phone's language. */
	private int stage;
	private String language = "";
	private String pendingLanguage;

	SpeechBridge(MainActivity activity, WebView web) {
		this.activity = activity;
		this.web = web;
	}

	@JavascriptInterface public void start(String lang) { main.post(() -> begin(lang == null ? "" : lang)); }
	@JavascriptInterface public void stop() { main.post(this::finishRequested); }
	@JavascriptInterface public void cancel() { main.post(this::abort); }

	void onMicPermission(boolean granted) {
		String lang = pendingLanguage;
		pendingLanguage = null;
		if (lang == null) return;
		if (granted) begin(lang);
		else emitError("Microphone permission denied");
	}

	private void begin(String lang) {
		if (active) abort();
		if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			pendingLanguage = lang;
			activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MIC);
			return;
		}
		language = regionalTag(lang);
		active = true;
		stopping = false;
		onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity);
		stage = onDevice ? 0 : 1;
		if (!onDevice && !SpeechRecognizer.isRecognitionAvailable(activity)) {
			active = false;
			emitError("This phone has no speech recognition service");
			return;
		}
		create();
		listen();
	}

	private void create() {
		if (recognizer != null) recognizer.destroy();
		recognizer = onDevice && Build.VERSION.SDK_INT >= 31
			? SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
			: SpeechRecognizer.createSpeechRecognizer(activity);
		recognizer.setRecognitionListener(this);
	}

	private void listen() {
		if (!active || recognizer == null) return;
		Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
		intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
		if (stage < 2 && !language.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
		intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, stage == 0);
		intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
		intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
		listening = true;
		recognizer.startListening(intent);
	}

	private void finishRequested() {
		if (!active) return;
		stopping = true;
		if (listening && recognizer != null) recognizer.stopListening();
		else end();
	}

	/** Page-initiated teardown (cancel or the end of a finished run): no events. */
	private void abort() {
		active = false;
		listening = false;
		pendingLanguage = null;
		if (recognizer != null) {
			recognizer.cancel();
			recognizer.destroy();
			recognizer = null;
		}
	}

	private void end() {
		abort();
		emit("end", null, null);
	}

	@Override public void onReadyForSpeech(Bundle params) { if (active) emit("ready", null, null); }
	@Override public void onBeginningOfSpeech() {}
	@Override public void onRmsChanged(float rmsdB) { if (active) emit("level", "db", rmsdB); }
	@Override public void onBufferReceived(byte[] buffer) {}
	@Override public void onEndOfSpeech() {}
	@Override public void onPartialResults(Bundle partialResults) {}
	@Override public void onEvent(int eventType, Bundle params) {}

	@Override public void onResults(Bundle results) {
		listening = false;
		if (!active) return;
		ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
		if (texts != null && !texts.isEmpty() && !texts.get(0).trim().isEmpty()) emit("final", "text", texts.get(0).trim());
		if (stopping) end();
		else listen();
	}

	@Override public void onError(int error) {
		listening = false;
		if (!active) return;
		boolean languageMissing = error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
			|| error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE;
		if (stage == 0 && (languageMissing || error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_SERVER)) {
			// No on-device model for this language: use the default service.
			onDevice = false;
			stage = 1;
			create();
			if (stopping) end(); else listen();
			return;
		}
		if (stage == 1 && languageMissing && !language.isEmpty()) {
			// The service can't take this tag: let it use the phone's language.
			stage = 2;
			if (stopping) end(); else listen();
			return;
		}
		if (stopping) { end(); return; }
		if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) { listen(); return; }
		if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) { main.postDelayed(this::listen, 300); return; }
		active = false;
		emitError(describe(error));
		end();
	}

	/** "en" → "en-US" (or the phone's own region when it speaks that language). */
	static String regionalTag(String lang) {
		if (lang.isEmpty() || lang.contains("-")) return lang;
		Locale phone = Locale.getDefault();
		if (phone.getLanguage().equals(lang) && !phone.getCountry().isEmpty()) return phone.toLanguageTag();
		switch (lang) {
			case "en": return "en-US";
			case "pt": return "pt-BR";
			case "zh": return "zh-CN";
			case "ja": return "ja-JP";
			case "ko": return "ko-KR";
			case "hi": return "hi-IN";
			case "da": return "da-DK";
			case "sv": return "sv-SE";
			case "nb": case "no": return "nb-NO";
			case "cs": return "cs-CZ";
			case "el": return "el-GR";
			case "uk": return "uk-UA";
			case "vi": return "vi-VN";
			case "he": return "he-IL";
			case "ar": return "ar-SA";
			case "et": return "et-EE";
			case "sl": return "sl-SI";
			case "ms": return "ms-MY";
			case "ta": return "ta-IN";
			case "bn": return "bn-IN";
			default: return lang + "-" + lang.toUpperCase(Locale.ROOT);
		}
	}

	private static String describe(int error) {
		switch (error) {
			case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "Microphone permission denied";
			case SpeechRecognizer.ERROR_NETWORK:
			case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "Speech recognition needs a network connection for this language";
			case SpeechRecognizer.ERROR_AUDIO: return "Microphone unavailable";
			case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
			case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "Speech recognition doesn't support this language on this phone";
			default: return "Speech recognition failed (" + error + ")";
		}
	}

	private void emitError(String message) { emit("error", "message", message); }

	private void emit(String type, String key, Object value) {
		try {
			JSONObject o = new JSONObject().put("type", type);
			if (key != null) o.put(key, value);
			String js = "window.dispatchEvent(new CustomEvent('lh:android-speech',{detail:" + o + "}))";
			main.post(() -> web.evaluateJavascript(js, null));
		} catch (Exception ignored) {}
	}
}
