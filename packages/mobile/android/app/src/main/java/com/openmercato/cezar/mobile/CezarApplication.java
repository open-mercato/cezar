package com.openmercato.cezar.mobile;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import com.openmercato.cezar.mobile.push.FcmTokenSource;
import com.openmercato.cezar.mobile.push.PushNotifier;
import com.openmercato.cezar.mobile.shell.AppLock;
import com.openmercato.cezar.mobile.shell.ShellServices;
import com.openmercato.cezar.mobile.shell.push.BadgeRefresh;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Exists so the lock watches every activity, including one restored first after process death (spec QR3). */
public final class CezarApplication extends Application {
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private int started;

    @Override
    public void onCreate() {
        super.onCreate();
        AppLock.get(this);
        // Before any activity, so the shell sees push as it is; the shell itself never names Firebase.
        ShellServices.setTokenSource(new FcmTokenSource(this));
        PushNotifier.createChannel(this);
        // Every computer's count on resume and while a page is open, not only on Your cezars (B1).
        // Every round, the badge's and Your cezars' alike, ends in one settle: what reached 0 is cleared (B3).
        ShellServices.setOnRoundEnd(() -> PushNotifier.settle(this));
        BadgeRefresh badges = new BadgeRefresh(this::probeRound, (ms, run) -> timer.schedule(run, ms, TimeUnit.MILLISECONDS),
                System::currentTimeMillis, () -> {});
        ShellServices.setBadges(badges);
        registerActivityLifecycleCallbacks(new Foreground(badges));
    }

    /** The Your cezars round, shared with that page; the page's own link is read, never let go. */
    private void probeRound(Runnable done) {
        ShellServices.probeRound(this, error -> done.run());
    }

    /** The app came to the front: its first activity started. */
    private final class Foreground implements ActivityLifecycleCallbacks {
        private final BadgeRefresh badges;

        Foreground(BadgeRefresh badges) {
            this.badges = badges;
        }

        @Override
        public void onActivityStarted(Activity activity) {
            if (started++ == 0) badges.resumed();
        }

        @Override
        public void onActivityStopped(Activity activity) {
            started = Math.max(0, started - 1);
        }

        @Override
        public void onActivityCreated(Activity activity, Bundle saved) {}

        @Override
        public void onActivityResumed(Activity activity) {}

        @Override
        public void onActivityPaused(Activity activity) {}

        @Override
        public void onActivitySaveInstanceState(Activity activity, Bundle out) {}

        @Override
        public void onActivityDestroyed(Activity activity) {}
    }
}
