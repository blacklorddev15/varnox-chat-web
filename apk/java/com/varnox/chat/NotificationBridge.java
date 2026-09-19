package com.varnox.chat;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * Android WebView implements neither the Web Notifications API nor the Web Push
 * API. This class supplies the missing half: it is exposed to the page as the
 * {@code VarnoxNotify} JavaScript interface and turns page-level notification
 * calls into real Android notifications, including the runtime permission flow
 * introduced in Android 13.
 */
public class NotificationBridge {

    static final String CHANNEL_ID = "varnox_messages";
    static final int REQ_POST_NOTIFICATIONS = 2001;

    private static final String GROUP_KEY = "com.varnox.chat.NOTIFICATIONS";
    private static final String PREFS = "varnox_prefs";
    private static final String PREF_PERMISSION_ASKED = "notification_permission_asked";
    private static final int MAX_TITLE = 120;
    private static final int MAX_BODY = 600;

    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());

    private int nextId = 1000;
    /** True while the page is waiting for the result of a permission request. */
    private boolean jsPermissionPending;

    NotificationBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = notificationManager();
        if (nm == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Message notifications", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("New messages and activity from Varnox Chat");
        channel.enableVibration(true);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    /**
     * Asks for POST_NOTIFICATIONS once, on the first cold start, behind an explanation.
     *
     * The OS dialog alone gives the user no reason to say yes, and a refusal is sticky - so the
     * rationale comes first, and "Not now" leaves the decision to the in-app settings screen.
     */
    void requestOnFirstLaunch() {
        if (Build.VERSION.SDK_INT < 33 || "granted".equals(currentPermission())) {
            return;
        }
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(PREF_PERMISSION_ASKED, false)) {
            return;
        }
        prefs.edit().putBoolean(PREF_PERMISSION_ASKED, true).apply();

        new AlertDialog.Builder(activity)
                .setTitle("Message notifications")
                .setMessage("Allow Varnox to notify you when someone messages you, including while the app is closed.")
                .setNegativeButton("Not now", null)
                .setPositiveButton("Continue", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        requestOsPermission();
                    }
                })
                .show();
    }

    // ------------------------------------------------------------------
    // Permission state
    // ------------------------------------------------------------------

    private NotificationManager notificationManager() {
        return (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private boolean osPermissionGranted() {
        if (Build.VERSION.SDK_INT < 33) {
            return true;
        }
        return activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * @return "granted" when notifications will be delivered, "default" when the
     *         OS dialog has not been answered yet, "denied" when the user or the
     *         system has switched notifications off for the app.
     */
    String currentPermission() {
        NotificationManager nm = notificationManager();
        if (nm != null && !nm.areNotificationsEnabled()) {
            return "denied";
        }
        if (!osPermissionGranted()) {
            return "default";
        }
        return "granted";
    }

    private void requestOsPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            activity.requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
        }
    }

    private void openNotificationSettings() {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", activity.getPackageName(), null));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(intent);
        } catch (Exception ignored) {
            // No settings activity available; the promise still resolves with "denied".
        }
    }

    /** Result forwarded from {@link MainActivity#onRequestPermissionsResult}. */
    void onPermissionResult(int requestCode, int[] grantResults) {
        if (requestCode != REQ_POST_NOTIFICATIONS) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (jsPermissionPending) {
            jsPermissionPending = false;
            deliverPermissionToPage(granted ? "granted" : "denied");
        }
    }

    /**
     * The user may have flipped the switch in system settings while the app was
     * paused, so re-check and answer any page request that is still waiting.
     */
    void onActivityResume() {
        if (jsPermissionPending && !"default".equals(currentPermission())) {
            jsPermissionPending = false;
            deliverPermissionToPage(currentPermission());
        }
    }

    private void deliverPermissionToPage(final String state) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) {
                    return;
                }
                webView.evaluateJavascript(
                        "window.__varnoxNotifyPermission && window.__varnoxNotifyPermission('"
                                + state + "')", null);
            }
        });
    }

    // ------------------------------------------------------------------
    // JavaScript interface
    // ------------------------------------------------------------------

    @JavascriptInterface
    public String permission() {
        return currentPermission();
    }

    @JavascriptInterface
    public boolean supported() {
        return true;
    }

    @JavascriptInterface
    public void requestPermission() {
        main.post(new Runnable() {
            @Override
            public void run() {
                String state = currentPermission();
                if ("granted".equals(state)) {
                    deliverPermissionToPage("granted");
                    return;
                }
                jsPermissionPending = true;
                if ("default".equals(state)) {
                    requestOsPermission();
                } else {
                    // Blocked at OS level: only system settings can re-enable it.
                    openNotificationSettings();
                }
            }
        });
    }

    @JavascriptInterface
    public void post(final String title, final String body, final String tag, final String url) {
        main.post(new Runnable() {
            @Override
            public void run() {
                show(title, body, tag, url);
            }
        });
    }

    @JavascriptInterface
    public void cancel(final String tag) {
        main.post(new Runnable() {
            @Override
            public void run() {
                NotificationManager nm = notificationManager();
                if (nm == null || tag == null || tag.isEmpty()) {
                    return;
                }
                nm.cancel(tag, tag.hashCode());
            }
        });
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private boolean isOwnPage(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        try {
            String host = Uri.parse(url).getHost();
            return host != null && (host.equals(MainActivity.HOST) || host.endsWith(".vercel.app"));
        } catch (Exception e) {
            return false;
        }
    }

    private void show(String title, String body, String tag, String url) {
        NotificationManager nm = notificationManager();
        if (nm == null) {
            return;
        }
        if (!"granted".equals(currentPermission())) {
            // Nothing can be displayed; the page is told via the Notification's
            // error/close callbacks only for its own accounting.
            return;
        }

        String safeTitle = clip(title, MAX_TITLE);
        String safeBody = clip(body, MAX_BODY);
        if (safeTitle.isEmpty() && safeBody.isEmpty()) {
            return;
        }
        if (safeTitle.isEmpty()) {
            safeTitle = activity.getString(R.string.app_name);
        }

        int id = (tag != null && !tag.isEmpty())
                ? Math.abs(tag.hashCode())
                : nextId++;

        Intent tapIntent = new Intent(activity, MainActivity.class);
        tapIntent.setAction(Intent.ACTION_VIEW);
        if (isOwnPage(url)) {
            tapIntent.setData(Uri.parse(url));
        }
        tapIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                activity, id, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(activity, CHANNEL_ID)
                : new Notification.Builder(activity);
        builder.setSmallIcon(R.drawable.ic_stat_varnox)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setGroup(GROUP_KEY)
                .setColor(0xFF4F8BFF);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
            builder.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            nm.notify(tag == null || tag.isEmpty() ? "varnox" : tag, id, builder.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked between the check and the call.
        }
    }

    private static String clip(String value, int max) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        return trimmed.length() <= max ? trimmed : trimmed.substring(0, max - 1) + "\u2026";
    }
}
