package com.varnox.chat;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Scanner;

/**
 * VARNOX - WebView wrapper for https://varnox-chat-web.vercel.app/
 *
 * Notification model
 * ------------------
 * The web app raises alerts with `new window.Notification(title, {body, tag})` and gates
 * its settings UI on `Notification.permission`; WebView implements neither. res/raw/
 * varnox_bridge.js shims that API onto the `VarnoxNative` interface implemented here, so
 * the web app still decides what is worth alerting about while the shell renders it with
 * the system NotificationManager.
 *
 * Delivery scope: alerts arrive while the app is running, including in the background,
 * backed by a foreground service that keeps the process and the live connection alive.
 * Real push (app woken after being killed) needs server-side credentials the project does
 * not expose here.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://varnox-chat-web.vercel.app/";
    private static final String APP_HOST = "varnox-chat-web.vercel.app";
    private static final String UA_SUFFIX = " VarnoxAndroid/1.3";

    private static final int REQ_FILE = 1001;
    private static final int REQ_WEB_PERM = 1002;
    private static final int REQ_NOTIFICATIONS = 1003;

    static final String EXTRA_NOTIFICATION_TAG = "varnox_notification_tag";

    /** Alerts are suppressed while the app is on screen - the message is already visible. */
    private static final boolean SUPPRESS_WHILE_VISIBLE = true;

    private WebView web;
    private ProgressBar progress;
    private LinearLayout offlineView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingPermissionRequest;

    private String bridgeScript;
    private volatile boolean visible;
    private String clickedTag;
    /** Mirrors the WebView's URL: the JS bridge calls in off the UI thread and must never
     *  touch the WebView itself, so the host check reads this instead. */
    private volatile String currentUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0B12);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0B12);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 6);
        progressParams.gravity = Gravity.TOP;
        root.addView(progress, progressParams);

        offlineView = buildOfflineView();
        offlineView.setVisibility(View.GONE);
        root.addView(offlineView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        VarnoxNotifications.ensureChannels(this);

        clickedTag = intentTag(getIntent());
        currentUrl = START_URL;
        configureWebView();
        requestNotificationPermissionIfNeeded();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    // ---------------------------------------------------------------- notifications

    boolean hasNotificationPermission() {
        return VarnoxNotifications.allowed(this);
    }

    void requestNotificationPermission() {
        requestNotificationPermissionIfNeeded();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (VarnoxNotifications.allowed(this)) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }

    /** Called from the JS bridge when the page raises an alert. */
    void postWebNotification(String title, String body, String tag) {
        if (!hasNotificationPermission()) return;
        if (SUPPRESS_WHILE_VISIBLE && visible) return;
        VarnoxNotifications.postMessage(this, title, body, tag);
    }

    /** Lets the page run the click handler it attached to the notification. */
    private void dispatchNotificationClick(String tag) {
        if (tag == null || web == null) return;
        String js = "window.__varnoxHandleNotificationClick && "
                + "window.__varnoxHandleNotificationClick(" + jsString(tag) + ")";
        web.evaluateJavascript(js, null);
    }

    private static String intentTag(Intent intent) {
        return intent == null ? null : intent.getStringExtra(EXTRA_NOTIFICATION_TAG);
    }

    private static String jsString(String value) {
        StringBuilder out = new StringBuilder("'");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\'' || c == '\\') out.append('\\').append(c);
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else out.append(c);
        }
        return out.append('\'').toString();
    }

    // ---------------------------------------------------------------- web view setup

    private LinearLayout buildOfflineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(0xFF0B0B12);
        box.setClickable(true);
        box.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                offlineView.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
                web.loadUrl(START_URL);
            }
        });

        TextView title = new TextView(this);
        title.setText(getString(R.string.offline_title));
        title.setTextColor(0xFFE8E8F0);
        title.setTextSize(18f);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.offline_hint));
        hint.setTextColor(0xFF8A8AA3);
        hint.setTextSize(14f);
        hint.setPadding(0, 24, 0, 0);
        hint.setGravity(Gravity.CENTER);
        box.addView(hint);

        return box;
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setLoadsImagesAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUserAgentString(s.getUserAgentString() + UA_SUFFIX);

        web.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        web.addJavascriptInterface(new NativeBridge(this), NativeBridge.JS_NAME);
        web.setWebViewClient(new AppWebViewClient());
        web.setWebChromeClient(new AppChromeClient());
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                openExternally(Uri.parse(url));
            }
        });
    }

    private String bridgeScript() {
        if (bridgeScript == null) {
            try (Scanner scanner = new Scanner(
                    getResources().openRawResource(R.raw.varnox_bridge), "UTF-8")) {
                scanner.useDelimiter("\\A");
                bridgeScript = scanner.hasNext() ? scanner.next() : "";
            } catch (Exception e) {
                bridgeScript = "";
            }
        }
        return bridgeScript;
    }

    private void injectBridge(WebView view) {
        String script = bridgeScript();
        if (script.isEmpty()) return;
        view.evaluateJavascript(script, null);
    }

    boolean isTrustedPage() {
        String url = currentUrl;
        if (url == null) return false;
        String host = Uri.parse(url).getHost();
        if (host == null) return false;
        return host.equals(APP_HOST) || host.endsWith("." + APP_HOST);
    }

    private boolean isInternal(Uri uri) {
        String host = uri.getHost();
        String scheme = uri.getScheme();
        if (scheme == null || host == null) return false;
        if (!scheme.equals("http") && !scheme.equals("https")) return false;
        return host.equals(APP_HOST) || host.endsWith("." + APP_HOST);
    }

    private void openExternally(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            currentUrl = url;
            injectBridge(view);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isInternal(uri)) {
                currentUrl = uri.toString();
                return false;
            }
            openExternally(uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            currentUrl = url;
            injectBridge(view);
            progress.setVisibility(View.GONE);
            if (clickedTag != null) {
                dispatchNotificationClick(clickedTag);
                clickedTag = null;
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                progress.setVisibility(View.GONE);
                offlineView.setVisibility(View.VISIBLE);
            }
        }
    }

    private class AppChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            progress.setProgress(newProgress);
            // Extra early injection opportunity: the app reads Notification.permission as
            // soon as it mounts, so give the shim every chance to be in place first.
            if (newProgress <= 30) injectBridge(view);
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                request.grant(request.getResources());
                return;
            }
            ArrayList<String> needed = new ArrayList<String>();
            for (String res : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                    needed.add(Manifest.permission.RECORD_AUDIO);
                }
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                    needed.add(Manifest.permission.CAMERA);
                }
            }
            if (needed.isEmpty()) {
                request.grant(request.getResources());
                return;
            }
            pendingPermissionRequest = request;
            requestPermissions(needed.toArray(new String[0]), REQ_WEB_PERM);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                         FileChooserParams fileChooserParams) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
            }
            pendingFileCallback = filePathCallback;

            Intent intent;
            try {
                intent = fileChooserParams.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "image/*", "video/*", "audio/*", "application/pdf", "text/plain"});
                if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
            } catch (Exception e) {
                intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
            }

            try {
                startActivityForResult(Intent.createChooser(intent, "Select file"), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                pendingFileCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == REQ_NOTIFICATIONS) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (web != null) {
                String state = granted ? "granted" : "denied";
                web.evaluateJavascript(
                        "window.__varnoxNotificationPermissionResult && "
                                + "window.__varnoxNotificationPermissionResult('" + state + "')", null);
            }
            return;
        }

        if (requestCode != REQ_WEB_PERM || pendingPermissionRequest == null) return;

        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) granted = false;
        }
        if (granted) {
            pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
        } else {
            pendingPermissionRequest.deny();
        }
        pendingPermissionRequest = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        pendingFileCallback.onReceiveValue(results);
        pendingFileCallback = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String tag = intentTag(intent);
        if (tag != null) dispatchNotificationClick(tag);
        VarnoxNotifications.cancelMessage(this, getString(R.string.app_name));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onStart() {
        super.onStart();
        Intent service = new Intent(this, VarnoxConnectionService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        // Deliberately NOT calling web.onPause(): the live connection must keep running so
        // messages can still alert while the app is in the background.
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        stopService(new Intent(this, VarnoxConnectionService.class));
        if (web != null) {
            web.setWebChromeClient(null);
            web.removeJavascriptInterface(NativeBridge.JS_NAME);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
