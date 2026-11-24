package com.openmercato.cezar.mobile.shell;

import java.io.File;
import java.io.IOException;

/** Whether the lock is on, as an empty file's presence: nothing here can hold a secret (spec QR3). */
public final class LockSetting {
    private final File file;

    public LockSetting(File directory) {
        this.file = new File(directory, "app-lock-on");
    }

    public boolean enabled() {
        return file.exists();
    }

    public void set(boolean enabled) throws IOException {
        if (enabled) {
            file.createNewFile();
            if (!file.exists()) throw new IOException("Could not save the lock setting");
        } else if (!file.delete() && file.exists()) {
            throw new IOException("Could not save the lock setting");
        }
    }
}
