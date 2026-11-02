package com.openmercato.cezar.mobile;

import android.app.Application;
import com.openmercato.cezar.mobile.shell.AppLock;

/** Exists so the lock watches every activity, including one restored first after process death (spec QR3). */
public final class CezarApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AppLock.get(this);
    }
}
