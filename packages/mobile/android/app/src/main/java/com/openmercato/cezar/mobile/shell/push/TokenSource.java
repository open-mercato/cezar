package com.openmercato.cezar.mobile.shell.push;

import java.io.IOException;

/** Where the phone's push token comes from: FCM in the app, a fake in tests. Never logged. */
public interface TokenSource {
    /** False without an initialized push service, such as a build with no `google-services.json`: push is then off. */
    boolean available();

    /** Blocks; call it off the main thread. */
    String token() throws IOException;

    TokenSource NONE = new TokenSource() {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public String token() throws IOException {
            throw new IOException("push is unavailable");
        }
    };
}
