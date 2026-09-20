package com.varnox.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps a call alive while the app is off screen.
 *
 * A WebView is frozen when its activity is backgrounded, and a frozen WebView cannot hold a WebRTC
 * connection. A foreground service is the mechanism Android provides for exactly this: while one is
 * running with a visible notification, the process is not a candidate for the freezer.
 *
 * The notification is not decoration. A foreground service without one is not permitted, and the
 * user is entitled to see that an app is holding their microphone - so it says which call is
 * running and tapping it returns to it.
 *
 * What this does NOT do is carry audio itself. The call still lives entirely in the WebView; this
 * only stops Android from suspending that WebView. If the page is torn down, the call ends, and no
 * amount of service is going to change that.
 */
public class CallService extends Service {

    static final String CHANNEL_ID = "varnox_calls_ongoing";
    static final String ACTION_START = "com.varnox.chat.action.CALL_START";
    static final String ACTION_STOP = "com.varnox.chat.action.CALL_STOP";

    private static final int NOTIFICATION_ID = 471101;
    private static final String EXTRA_PEER = "peer";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }

        String peer = intent != null ? intent.getStringExtra(EXTRA_PEER) : null;
        Notification notification = buildNotification(peer);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // The type has to be declared here as well as in the manifest, or Android 10+ refuses
            // to promote the service to the foreground.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        // START_STICKY because the call may still be connected: if Android reclaims the process under
        // memory pressure it should bring this back rather than silently ending the call. The page
        // tells us when the call is actually over, via setCallActive(false).
        return START_STICKY;
    }

    /**
     * Nothing binds to this. The service exists to hold the process, not to serve requests, so there
     * is no binder to hand out.
     */
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        // IMPORTANCE_LOW: an ongoing call should sit quietly in the shade rather than announce itself
        // with a sound every time the connection is re-established.
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Calls in progress",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while a Varnox call is connected in the background.");
        channel.setShowBadge(false);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String peer) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        builder.setContentTitle(peer != null && !peer.isEmpty() ? "Call with " + peer : "Call in progress")
                .setContentText("Tap to return to the call")
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setShowWhen(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_CALL);
        }

        return builder.build();
    }
}
