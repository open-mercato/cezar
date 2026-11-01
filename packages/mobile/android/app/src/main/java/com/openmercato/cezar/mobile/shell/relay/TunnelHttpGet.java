package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.HttpAnswer;
import com.openmercato.cezar.mobile.shell.HttpGet;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;

/** `HealthProbe`'s tunnel transport. `url` is a path here, since a relay server has no origin to name. */
public final class TunnelHttpGet implements HttpGet {
    private static final long TIMEOUT_MS = 10000;
    private static final int MAX_BODY = 256 * 1024;

    private final Supplier<TunnelSession> sessions;

    public TunnelHttpGet(Supplier<TunnelSession> sessions) {
        this.sessions = sessions;
    }

    @Override
    public HttpAnswer get(String url, Map<String, String> headers) throws IOException {
        TunnelSession session = sessions.get();
        if (session == null) throw new IOException("no session");
        List<TunnelFrame.Header> forwarded = new ArrayList<>();
        for (Map.Entry<String, String> header : headers.entrySet()) {
            forwarded.add(new TunnelFrame.Header(header.getKey().toLowerCase(Locale.ROOT), header.getValue()));
        }
        TunnelStream stream = session.open("GET", url, forwarded);
        try {
            stream.finishRequest();
            return read(stream);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        } finally {
            stream.cancel(TunnelFrame.RESET_CANCELLED);
        }
    }

    private static HttpAnswer read(TunnelStream stream) throws IOException, InterruptedException {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        Map<String, List<String>> headers = new HashMap<>();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        int status = 0;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            TunnelStream.Event event = left > 0 ? stream.next(left) : null;
            if (event == null) throw new IOException("timed out");
            switch (event.kind) {
                case HEAD:
                    status = event.status;
                    for (TunnelFrame.Header header : event.headers) {
                        if (!headers.containsKey(header.name)) headers.put(header.name, new ArrayList<String>());
                        headers.get(header.name).add(header.value);
                    }
                    break;
                case DATA:
                    if (body.size() < MAX_BODY) body.write(event.data);
                    stream.consumed(event.data.length);
                    break;
                case END:
                    return new HttpAnswer(status, headers, new String(body.toByteArray(), StandardCharsets.UTF_8));
                default:
                    throw new IOException("stream ended");
            }
        }
    }
}
