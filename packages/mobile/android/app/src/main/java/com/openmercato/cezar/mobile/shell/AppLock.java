package com.openmercato.cezar.mobile.shell;

import android.app.Activity;
import android.app.Application;
import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import java.io.IOException;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.function.Consumer;

/**
 * The optional lock (spec QR3). A UI gate over this process's activities, never a key-release
 * gate: it holds no key and no key depends on it. Main thread, except the two getters.
 */
public final class AppLock implements Application.ActivityLifecycleCallbacks {
    /** An activity that can show the lock. Any other one is closed while locked, so the scanner cannot outlive it. */
    public interface Host {}

    /** Weak with device credential is the one mix androidx.biometric supports from API 24 up. */
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    private static AppLock instance;

    private final LockPolicy policy = new LockPolicy();
    private final Set<Activity> started = Collections.newSetFromMap(new IdentityHashMap<>());
    private final LockSetting setting;
    private final KeyguardManager keyguard;
    private volatile boolean enabled;
    private Runnable afterUnlock;

    private AppLock(Application application) {
        setting = new LockSetting(application.getNoBackupFilesDir());
        keyguard = application.getSystemService(KeyguardManager.class);
        enabled = setting.enabled();
        application.registerActivityLifecycleCallbacks(this);
    }

    /** Before super.onCreate, in every Host: a restored process may start at either one. */
    public static synchronized AppLock install(Activity activity) {
        if (instance == null) instance = new AppLock(activity.getApplication());
        return instance;
    }

    public static synchronized AppLock get(Context context) {
        if (instance == null) instance = new AppLock((Application) context.getApplicationContext());
        return instance;
    }

    public boolean enabled() {
        return enabled;
    }

    /** Whether the phone has a PIN, pattern or password. Biometrics cannot exist without one. */
    public boolean available() {
        return keyguard.isDeviceSecure();
    }

    /** Dormant with no device credential: removing one takes that credential, so this adds no exposure (spec QR3). */
    private boolean active() {
        return enabled && available();
    }

    private boolean locked() {
        return policy.promptNeeded(active());
    }

    /** Runs now, or after the unlock. Only the newest waits: a reloaded page's launch replaces the old one. */
    public void whenUnlocked(Runnable work) {
        if (!locked()) {
            work.run();
            return;
        }
        afterUnlock = work;
    }

    /** Both directions need the credential. `done` gets null, or why nothing changed. */
    public void change(FragmentActivity activity, boolean on, Consumer<String> done) {
        if (!available()) {
            done.accept("Set a screen lock on this phone first.");
            return;
        }
        authenticate(activity, on ? "Turn on app lock" : "Turn off app lock", error -> {
            if (error != null) {
                done.accept(error);
                return;
            }
            try {
                setting.set(on);
            } catch (IOException e) {
                done.accept(e.getMessage());
                return;
            }
            enabled = on;
            policy.passed();
            apply(activity);
            done.accept(null);
        });
    }

    private void authenticate(FragmentActivity activity, String title, Consumer<String> done) {
        policy.promptStarted();
        new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                policy.promptEnded();
                done.accept(null);
            }

            @Override
            public void onAuthenticationError(int code, CharSequence text) {
                policy.promptEnded();
                done.accept(text.toString());
            }
        }).authenticate(new BiometricPrompt.PromptInfo.Builder().setTitle(title)
                .setAllowedAuthenticators(AUTHENTICATORS).build());
    }

    private void unlock(FragmentActivity activity) {
        authenticate(activity, "Unlock Cezar", error -> {
            if (error != null) {
                LockShield shield = shield(activity);
                if (shield != null) shield.show(error);
                return;
            }
            policy.passed();
            apply(activity);
            flush();
        });
    }

    private void flush() {
        Runnable work = afterUnlock;
        afterUnlock = null;
        if (work != null) work.run();
    }

    /** Hidden, not only covered: an invisible page has no focus, so a key or a screen reader cannot reach it. */
    private void apply(Activity activity) {
        if (!(activity instanceof Host)) return;
        hideFromRecents(activity, active());
        ViewGroup content = activity.findViewById(android.R.id.content);
        LockShield shield = shield(activity);
        boolean locked = locked();
        if (locked == (shield != null)) return;
        if (locked) {
            shield = new LockShield((FragmentActivity) activity, () -> unlock((FragmentActivity) activity));
            content.addView(shield, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } else {
            shield.release();
            content.removeView(shield);
        }
        for (int i = 0; i < content.getChildCount(); i++) {
            View child = content.getChildAt(i);
            if (child != shield) child.setVisibility(locked ? View.INVISIBLE : View.VISIBLE);
        }
    }

    private static LockShield shield(Activity activity) {
        ViewGroup content = activity.findViewById(android.R.id.content);
        for (int i = 0; i < content.getChildCount(); i++) {
            if (content.getChildAt(i) instanceof LockShield) return (LockShield) content.getChildAt(i);
        }
        return null;
    }

    /** The snapshot is taken on the way out, before any lock shows, so with the lock on there is none. */
    private static void hideFromRecents(Activity activity, boolean hide) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.setRecentsScreenshotEnabled(!hide);
        } else if (hide) {
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    /** Started, not resumed: this runs before the frame that would otherwise show the page. */
    @Override
    public void onActivityStarted(Activity activity) {
        if (started.isEmpty()) policy.returned(SystemClock.elapsedRealtime());
        started.add(activity);
        apply(activity);
    }

    @Override
    public void onActivityResumed(Activity activity) {
        if (!locked()) {
            apply(activity);
            flush();
            return;
        }
        if (!(activity instanceof Host)) activity.finish();
        else if (policy.autoPrompt(active())) unlock((FragmentActivity) activity);
    }

    @Override
    public void onActivityStopped(Activity activity) {
        if (started.remove(activity) && started.isEmpty()) policy.left(SystemClock.elapsedRealtime(), activity.isChangingConfigurations());
    }

    @Override
    public void onActivityCreated(Activity activity, Bundle state) {}

    @Override
    public void onActivityPaused(Activity activity) {}

    @Override
    public void onActivitySaveInstanceState(Activity activity, Bundle state) {}

    @Override
    public void onActivityDestroyed(Activity activity) {}
}
