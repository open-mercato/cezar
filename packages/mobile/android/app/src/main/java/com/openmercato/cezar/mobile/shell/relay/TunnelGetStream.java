package com.openmercato.cezar.mobile.shell.relay;

import java.io.EOFException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** A GET whose body never ends by itself, read as it arrives. {@link TunnelHttp} buffers whole answers instead. */
public final class TunnelGetStream {
    private static final long HEAD_TIMEOUT_MS = 10000;

    private final TunnelStream stream;
    private final int status;

    private TunnelGetStream(TunnelStream stream, int status) {
        this.stream = stream;
        this.status = status;
    }

    /** Waits for the head. `path` is origin-form, as for {@link TunnelHttp}. */
    public static TunnelGetStream open(TunnelSession session, String path, Map<String, String> headers) throws IOException {
        if (session == null) throw new IOException("no session");
        List<TunnelFrame.Header> forwarded = new ArrayList<>();
        for (Map.Entry<String, String> header : headers.entrySet()) {
            forwarded.add(new TunnelFrame.Header(header.getKey().toLowerCase(Locale.ROOT), header.getValue()));
        }
        TunnelStream stream = session.open("GET", path, forwarded);
        try {
            stream.finishRequest();
            TunnelStream.Event head = stream.next(HEAD_TIMEOUT_MS);
            if (head == null || head.kind != TunnelStream.Kind.HEAD) throw new IOException("no head");
            return new TunnelGetStream(stream, head.status);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            stream.cancel(TunnelFrame.RESET_CANCELLED);
            throw new IOException(e);
        } catch (IOException e) {
            stream.cancel(TunnelFrame.RESET_CANCELLED);
            throw e;
        }
    }

    public int status() {
        return status;
    }

    /** The next bytes, credited back as taken, or null after `timeoutMs`. Throws once the stream has ended. */
    public byte[] read(long timeoutMs) throws IOException {
        TunnelStream.Event event;
        try {
            event = stream.next(timeoutMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        }
        if (event == null) return null;
        switch (event.kind) {
            case DATA:
                stream.consumed(event.data.length);
                return event.data;
            case END:
                throw new EOFException();
            default:
                throw new IOException("stream ended");
        }
    }

    public void close() {
        stream.cancel(TunnelFrame.RESET_CANCELLED);
    }
}
