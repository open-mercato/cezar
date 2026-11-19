package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.HttpAnswer;
import com.openmercato.cezar.mobile.shell.HttpGet;
import java.io.IOException;
import java.util.Map;
import java.util.function.Supplier;

/** `HealthProbe`'s tunnel transport. `url` is a path here, since a relay server has no origin to name. */
public final class TunnelHttpGet implements HttpGet {
    private final TunnelHttp http;

    public TunnelHttpGet(Supplier<TunnelSession> sessions) {
        this.http = new TunnelHttp(sessions);
    }

    @Override
    public HttpAnswer get(String url, Map<String, String> headers) throws IOException {
        return http.send("GET", url, headers, null);
    }
}
