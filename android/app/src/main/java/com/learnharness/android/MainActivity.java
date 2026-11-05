package com.learnharness.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** The app window: a WebView on the bundled server, plus a status screen. */
public final class MainActivity extends Activity implements ServerRuntime.Listener {
	private static final int REQUEST_WEB_MIC = 42;

	private WebView web;
	private SpeechBridge speech;
	private FileBridge files;
	private static final int REQUEST_WEB_FILES = 53;
	private android.webkit.ValueCallback<Uri[]> pendingWebFiles;
	private LinearLayout status;
	private TextView statusText;
	private Button retry;
	private boolean loaded;
	private PermissionRequest pendingWebMic;

	@Override protected void onCreate(Bundle saved) {
		super.onCreate(saved);
		FrameLayout rootView = new FrameLayout(this);
		rootView.setBackgroundColor(Color.parseColor("#141414"));

		web = new WebView(this);
		web.setVisibility(View.INVISIBLE);
		WebView.setWebContentsDebuggingEnabled(true);
		WebSettings s = web.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setAllowFileAccess(false);
		s.setAllowContentAccess(false);
		s.setSupportMultipleWindows(false);
		// Phone layout: honor the page's device-width viewport, never zoom out to fit.
		s.setUseWideViewPort(true);
		s.setLoadWithOverviewMode(false);
		s.setSupportZoom(false);
		s.setBuiltInZoomControls(false);
		s.setTextZoom(100);
		s.setUserAgentString(s.getUserAgentString() + " LearnHarnessAndroid");
		web.setWebViewClient(new WebViewClient() {
			@Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
				Uri u = req.getUrl();
				if ("127.0.0.1".equals(u.getHost()) && u.getPort() == ServerRuntime.port) return false;
				try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
				return true;
			}
			@Override public void onPageFinished(WebView view, String url) { web.setVisibility(View.VISIBLE); status.setVisibility(View.GONE); }
		});
		web.setWebChromeClient(new WebChromeClient() {
			// <input type="file"> (e.g. Extract files…): the system picker.
			@Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
				if (pendingWebFiles != null) pendingWebFiles.onReceiveValue(null);
				pendingWebFiles = callback;
				try {
					Intent i = params.createIntent();
					if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
					startActivityForResult(i, REQUEST_WEB_FILES);
				} catch (Exception e) {
					pendingWebFiles = null;
					return false;
				}
				return true;
			}
			@Override public void onPermissionRequest(PermissionRequest request) {
				runOnUiThread(() -> {
					boolean audioOnly = true;
					for (String r : request.getResources()) if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audioOnly = false;
					if (!audioOnly || !"127.0.0.1".equals(request.getOrigin().getHost())) { request.deny(); return; }
					if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
						request.grant(request.getResources());
					} else {
						pendingWebMic = request;
						requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_WEB_MIC);
					}
				});
			}
		});
		speech = new SpeechBridge(this, web);
		web.addJavascriptInterface(speech, "LHAndroidSpeech");
		files = new FileBridge(this, web);
		web.addJavascriptInterface(files, "LHAndroidFiles");
		rootView.addView(web, new FrameLayout.LayoutParams(-1, -1));

		status = new LinearLayout(this);
		status.setOrientation(LinearLayout.VERTICAL);
		status.setGravity(Gravity.CENTER);
		status.setPadding(48, 48, 48, 48);
		statusText = new TextView(this);
		statusText.setTextColor(Color.parseColor("#bbbbbb"));
		statusText.setTextSize(15);
		statusText.setGravity(Gravity.CENTER);
		statusText.setTextIsSelectable(true);
		ScrollView scroll = new ScrollView(this);
		scroll.addView(statusText);
		status.addView(scroll, new LinearLayout.LayoutParams(-1, -2));
		retry = new Button(this);
		retry.setText("Retry");
		retry.setVisibility(View.GONE);
		retry.setOnClickListener(v -> { retry.setVisibility(View.GONE); startServer(); });
		status.addView(retry, new LinearLayout.LayoutParams(-2, -2));
		rootView.addView(status, new FrameLayout.LayoutParams(-1, -1));
		setContentView(rootView);
		// Edge-to-edge (Android 15+): keep content clear of the status bar,
		// navigation bar, cutout and keyboard.
		rootView.setOnApplyWindowInsetsListener((v, insets) -> {
			if (Build.VERSION.SDK_INT >= 30) {
				android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars()
					| WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
				v.setPadding(i.left, i.top, i.right, i.bottom);
			} else {
				v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
					insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
			}
			return WindowInsets.CONSUMED;
		});

		if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
			requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
		}
		startServer();
		ServerRuntime.listen(this);
	}

	private void startServer() { startForegroundService(new Intent(this, ServerService.class)); }

	@Override public void onState(ServerRuntime.State state, String detail) {
		runOnUiThread(() -> {
			switch (state) {
				case READY:
					if (loaded) return;
					loaded = true;
					CookieManager cm = CookieManager.getInstance();
					cm.setAcceptCookie(true);
					cm.setCookie(ServerRuntime.url(), "lh_android=" + ServerRuntime.secret + "; Path=/; HttpOnly; SameSite=Strict");
					cm.flush();
					web.loadUrl(ServerRuntime.url());
					break;
				case FAILED:
					loaded = false;
					web.setVisibility(View.INVISIBLE);
					status.setVisibility(View.VISIBLE);
					statusText.setText("LearnHarness couldn't start.\n\n" + detail);
					retry.setVisibility(View.VISIBLE);
					break;
				default:
					if (!loaded) statusText.setText(detail.isEmpty() ? "Starting…" : detail);
			}
		});
	}

	@Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
		boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
		if (code == SpeechBridge.REQUEST_MIC) speech.onMicPermission(granted);
		if (code == REQUEST_WEB_MIC && pendingWebMic != null) {
			if (granted) pendingWebMic.grant(pendingWebMic.getResources());
			else pendingWebMic.deny();
			pendingWebMic = null;
		}
	}

	@Override protected void onActivityResult(int code, int resultCode, Intent data) {
		super.onActivityResult(code, resultCode, data);
		if (code == FileBridge.REQUEST_FILES || code == FileBridge.REQUEST_FOLDER) { files.onResult(code, resultCode, data); return; }
		if (code == REQUEST_WEB_FILES && pendingWebFiles != null) {
			Uri[] result = null;
			if (resultCode == RESULT_OK && data != null) {
				if (data.getClipData() != null) {
					result = new Uri[data.getClipData().getItemCount()];
					for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
				} else if (data.getData() != null) result = new Uri[] { data.getData() };
			}
			pendingWebFiles.onReceiveValue(result);
			pendingWebFiles = null;
		}
	}

	@Override public void onBackPressed() {
		if (web.canGoBack()) web.goBack();
		else moveTaskToBack(true);
	}

	@Override protected void onDestroy() {
		ServerRuntime.unlisten(this);
		speech.cancel();
		web.destroy();
		super.onDestroy();
	}
}
