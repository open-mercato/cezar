package com.openmercato.cezar.mobile.shell.push;

import java.io.IOException;
import java.util.Map;

/** The relay's two push `POST` routes, as a transport: OkHttp in the app, a fake in tests. */
public interface PushRelay {
    final class Answer {
        public final int status;
        /** The refusal's `code`, or null. */
        public final String code;
        /** Seconds, or -1 without a usable `Retry-After`. */
        public final long retryAfter;
        /** The `Date` header in milliseconds, or -1. */
        public final long date;
        public final String body;

        public Answer(int status, String code, long retryAfter, long date, String body) {
            this.status = status;
            this.code = code;
            this.retryAfter = retryAfter;
            this.date = date;
            this.body = body;
        }
    }

    Answer post(String url, Map<String, String> headers, byte[] body) throws IOException;
}
