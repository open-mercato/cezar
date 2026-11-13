package com.openmercato.cezar.mobile.shell.relay;

import java.util.Map;

/** The WebSocket seam, so the relay state machines run on the JVM against a fake. */
public interface SocketTransport {
    interface Events {
        void opened();
        void text(String text);
        void binary(byte[] bytes);
        void closed(int code);

        /** The close frame's reason, when the peer sent one: § 18 reads it after a 4451. */
        default void closed(int code, String reason) {
            closed(code);
        }
        /** No socket: `status` is the HTTP refusal, 0 for a network failure. Negative values mean unknown. */
        void failed(int status, String code, long retryAfterSeconds, long dateMillis);
    }

    interface Connection {
        boolean sendText(String text);
        boolean sendBinary(byte[] bytes);
        void close(int code);
    }

    Connection connect(String url, Map<String, String> headers, Events events);
}
