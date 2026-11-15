package com.openmercato.cezar.mobile.push;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.openmercato.cezar.mobile.MainActivity;
import com.openmercato.cezar.mobile.R;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import com.openmercato.cezar.mobile.shell.ShellConnector;
import com.openmercato.cezar.mobile.shell.ShellServices;
import com.openmercato.cezar.mobile.shell.push.PushTap;
import com.openmercato.cezar.mobile.shell.push.PushText;

/** The one channel, and the notification the app posts itself: an FCM message in the foreground, or a Stage 1 signal (spec R5). */
public final class PushNotifier {
    public static final String EXTRA_CEZAR_ID = PushTap.EXTRA;
    private static final int ID = 1;

    private PushNotifier() {}

    /** Created at app start, so the system tray's notification finds it before any message arrives. */
    public static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(context.getString(R.string.push_channel_id),
                context.getString(R.string.push_channel_name), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.push_channel_description));
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    /** Named on the phone: the computer's own name over "Needs you". One per cezar, like the relay's collapse key. */
    public static void post(Context context, String cezarId) {
        post(context, cezarId, null);
    }

    /** `managerId`, from a signal inside the session, rides a local-only extra and never reaches the text. */
    public static void post(Context context, String cezarId, String managerId) {
        ShellConnector connector = ShellServices.connector(context);
        ServerRecord server = PushTap.serverFor(cezarId, connector.list());
        // A forgotten server's grant can outlive it (§ 7); its tap would only reach the start screen.
        if (server == null || !allowed(context)) return;
        Intent open = new Intent(context, MainActivity.class)
                .putExtra(EXTRA_CEZAR_ID, cezarId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (PushTap.validManagerId(managerId)) open.putExtra(PushTap.EXTRA_MANAGER, managerId);
        PendingIntent tap = PendingIntent.getActivity(context, cezarId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, context.getString(R.string.push_channel_id))
                .setSmallIcon(R.drawable.ic_stat_cezar)
                .setContentTitle(PushText.title(server.label, context.getString(R.string.push_title)))
                .setContentText(context.getString(R.string.push_body_named))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(tap);
        // The launcher badge: the sum of last-known counts over every computer (switcher spec).
        builder.setNumber(PushText.number(connector.totalNeed(), othersShown(context, cezarId)));
        try {
            NotificationManagerCompat.from(context).notify(cezarId, ID, builder.build());
        } catch (SecurityException e) {
            // The permission went away between the check and the post.
        }
    }

    /** What the other cezars' notifications already add to a summing launcher's badge. */
    private static int othersShown(Context context, String cezarId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return 0;
        int shown = 0;
        try {
            for (StatusBarNotification active : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                if (active.getId() != ID || cezarId.equals(active.getTag())) continue;
                Notification notification = active.getNotification();
                shown += Math.max(1, notification.number);
            }
        } catch (RuntimeException e) {
            return 0;
        }
        return shown;
    }

    public static boolean allowed(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }
}
