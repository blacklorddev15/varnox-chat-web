package com.varnox.chat;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

/**
 * Thin native shell that renders the Varnox Chat web app (a Next/Expo web build
 * hosted on Vercel) inside a full-screen WebView, plus the platform glue a chat
 * app needs: file uploads, camera/microphone capture, downloads, deep links,
 * back navigation and session persistence.
 */
public class MainActivity extends Activity {

    static final String START_URL = "https://varnox-chat-web.vercel.app/";
    static final String HOST = "varnox-chat-web.vercel.app";

    private static final String JS_INTERFACE_NAME = "VarnoxNotify";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_RUNTIME_PERMISSIONS = 1002;

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingPermissionRequest;
    private NotificationBridge notificationBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#FF171717"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#FF171717"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(ColorStateList.valueOf(Color.parseColor("#FF4F8BFF")));
        progressBar.setBackgroundColor(Color.TRANSPARENT);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        progressParams.topMargin = 0;
        root.addView(progressBar, progressParams);

        setContentView(root);

        configureWebView();

        notificationBridge = new NotificationBridge(this, webView);
        notificationBridge.createChannel();
        webView.addJavascriptInterface(notificationBridge, JS_INTERFACE_NAME);
        notificationBridge.requestOnFirstLaunch();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            Uri launchUri = resolveLaunchUri(getIntent());
            webView.loadUrl(launchUri != null ? launchUri.toString() : START_URL);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setGeolocationEnabled(false);
        // Voice notes / video playback inside chat should not need an extra tap.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(view, request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(view, Uri.parse(url));
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // Installed as early as possible so the app's own feature
                // detection ("Notification" in window) sees the shim.
                injectNotificationShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                injectNotificationShim(view); // idempotent safety net
                syncMessageWatcher();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showOfflineDialog();
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Never silently continue past a certificate problem.
                handler.cancel();
                showOfflineDialog();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker available",
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        handleWebPermissionRequest(request);
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingPermissionRequest == request) {
                    pendingPermissionRequest = null;
                }
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "No app can open this download",
                            Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    /** Keep web navigation in the WebView; hand anything else to the system. */
    private boolean handleUrl(WebView view, Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        scheme = scheme.toLowerCase();
        if ("http".equals(scheme) || "https".equals(scheme)) {
            String host = uri.getHost();
            if (host != null && (host.equals(HOST) || host.endsWith(".vercel.app"))) {
                return false; // load in-app
            }
            // External links, OAuth providers, etc. also stay in-app so the
            // session/session-storage stays available to the chat app.
            return false;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Nothing can open " + scheme + " links",
                    Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        boolean needsCamera = false;
        boolean needsMic = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                needsCamera = true;
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                needsMic = true;
            }
        }

        if (!needsCamera && !needsMic) {
            request.deny();
            return;
        }

        if (hasPermissions(needsCamera, needsMic)) {
            request.grant(request.getResources());
            return;
        }

        pendingPermissionRequest = request;
        requestRuntimePermissions(needsCamera, needsMic);
    }

    private boolean hasPermissions(boolean camera, boolean mic) {
        if (camera && checkSelfPermission(android.Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        if (mic && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return true;
    }

    private void requestRuntimePermissions(boolean camera, boolean mic) {
        java.util.ArrayList<String> wanted = new java.util.ArrayList<String>();
        if (camera) {
            wanted.add(android.Manifest.permission.CAMERA);
        }
        if (mic) {
            wanted.add(android.Manifest.permission.RECORD_AUDIO);
        }
        if (wanted.isEmpty()) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(wanted.toArray(new String[0]), REQ_RUNTIME_PERMISSIONS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (notificationBridge != null) {
            notificationBridge.onPermissionResult(requestCode, grantResults);
        }
        if (requestCode != REQ_RUNTIME_PERMISSIONS || pendingPermissionRequest == null) {
            return;
        }
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                granted = false;
                break;
            }
        }
        if (granted) {
            pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
        } else {
            pendingPermissionRequest.deny();
        }
        pendingPermissionRequest = null;
    }

    private Uri resolveLaunchUri(Intent intent) {
        if (intent == null || intent.getData() == null) {
            return null;
        }
        return intent.getData();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri uri = resolveLaunchUri(intent);
        if (uri != null && webView != null) {
            // Reached by tapping a notification: land on the page it came from.
            webView.loadUrl(uri.toString());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback == null) {
                return;
            }
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                try {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                } catch (Exception e) {
                    results = null;
                }
            }
            pendingFileCallback.onReceiveValue(results);
            pendingFileCallback = null;
        }
    }

    private void showOfflineDialog() {
        progressBar.setVisibility(View.GONE);
        new AlertDialog.Builder(this)
                .setTitle("Can't reach Varnox Chat")
                .setMessage("Check your internet connection and try again.")
                .setCancelable(false)
                .setPositiveButton("Retry", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        webView.reload();
                    }
                })
                .setNegativeButton("Close", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        finish();
                    }
                })
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        if (notificationBridge != null) {
            // The user may have enabled notifications in system settings while away.
            notificationBridge.onActivityResume();
        }
        syncMessageWatcher();
    }

    /**
     * Keeps the background message watcher running exactly when it can be useful: signed in and
     * allowed to notify. Signing out or denying notifications stops it, so it never polls for a
     * session that cannot be seen or a notification that cannot be shown.
     */
    private void syncMessageWatcher() {
        if (notificationBridge == null) {
            return;
        }
        boolean signedIn = false;
        try {
            String cookie = CookieManager.getInstance().getCookie(START_URL);
            signedIn = cookie != null && !cookie.isEmpty();
        } catch (Exception ignored) {
            // Treat an unreadable cookie store as signed out.
        }
        if (signedIn && "granted".equals(notificationBridge.currentPermission())) {
            MessageWatcherService.start(this);
        } else {
            MessageWatcherService.stop(this);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * Injects res/raw/varnox_notify_shim.js, which defines window.Notification
     * (absent in WebView) and forwards calls to the native bridge. The shim
     * guards against double-installation, so repeated calls are harmless.
     */
    private void injectNotificationShim(WebView view) {
        try {
            java.io.InputStream in = getResources().openRawResource(R.raw.varnox_notify_shim);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            in.close();
            view.evaluateJavascript(out.toString("UTF-8"), null);
        } catch (Exception ignored) {
            // The shim is an enhancement; never let it break page loading.
        }
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }
}
