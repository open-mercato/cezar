package com.openmercato.cezar.mobile.shell;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.net.ssl.SSLException;

/** Reads a server's health natively, before any page loads (spec "In the shell"). */
public final class HealthProbe {
    private final HttpGet http;
    private final String userAgent;

    public HealthProbe(HttpGet http, String userAgent) {
        this.http = http;
        this.userAgent = userAgent;
    }

    public HealthAnswer probe(ServerOrigin origin, String username, String password, String cookies) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/json");
        headers.put("User-Agent", userAgent);
        if (password != null) headers.put("Authorization", basic(username, password));
        if (cookies != null && !cookies.isEmpty()) headers.put("Cookie", cookies);
        try {
            return HealthClassifier.classify(http.get(origin.url("/api/v1/health"), headers));
        } catch (SSLException e) {
            return HealthAnswer.of(HealthAnswer.Kind.TLS_FAILURE, 0);
        } catch (IOException e) {
            return HealthAnswer.of(HealthAnswer.Kind.UNREACHABLE, 0);
        }
    }

    private static String basic(String username, String password) {
        byte[] pair = ((username == null ? "" : username) + ":" + password).getBytes(StandardCharsets.UTF_8);
        return "Basic " + Base64.getEncoder().encodeToString(pair);
    }
}
