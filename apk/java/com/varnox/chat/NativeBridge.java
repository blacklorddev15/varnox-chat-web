package com.varnox.chat;

import android.webkit.JavascriptInterface;

/**
 * The `VarnoxNative` object exposed to the web page.
 *
 * Only the app's own origin is served inside the WebView (everything else is pushed to the
 * system browser), and every call is re-checked against the loaded host before it is acted
 * on, so page scripts from anywhere else cannot reach the notification APIs.
 */
class NativeBridge {

    static final String JS_NAME = "VarnoxNative";

    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean hasNotificationPermission() {
        if (!activity.isTrustedPage()) return false;
        return activity.hasNotificationPermission();
    }

    @JavascriptInterface
    public void requestNotificationPermission() {
        if (!activity.isTrustedPage()) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.requestNotificationPermission();
            }
        });
    }

    @JavascriptInterface
    public void setCallActive(final boolean active) {
        if (!activity.isTrustedPage()) return;
        activity.setCallActive(active);
    }

    @JavascriptInterface
    public void postNotification(final String title, final String body, final String tag) {
        if (!activity.isTrustedPage()) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.postWebNotification(title, body, tag);
            }
        });
    }
}
