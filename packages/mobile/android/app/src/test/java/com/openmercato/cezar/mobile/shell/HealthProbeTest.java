package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.SSLHandshakeException;
import org.junit.After;
import org.junit.Test;

public class HealthProbeTest {
    private ServerSocket server;

    @After
    public void stop() throws IOException {
        if (server != null) server.close();
    }

    /** Answers every connection with `response`, and counts requests for /elsewhere. */
    private String serve(String response, AtomicInteger elsewhere) throws IOException {
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        Thread thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    String line = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)).readLine();
                    if (line != null && line.contains("/elsewhere")) elsewhere.incrementAndGet();
                    OutputStream out = socket.getOutputStream();
                    out.write(response.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                } catch (IOException e) {
                    return;
                }
            }
        });
        thread.setDaemon(true);
        thread.start();
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    private static ServerOrigin origin() throws Exception {
        return ServerOrigin.parse("https://cezar.example.com");
    }

    @Test
    public void sendsBasicOnlyWhenGivenAPassword() throws Exception {
        Map<String, String> seen = new HashMap<>();
        HealthProbe probe = new HealthProbe((url, headers) -> {
            seen.clear();
            seen.putAll(headers);
            return HealthClassifierTest.answer(200, "application/json", null, "{\"version\":\"1\",\"capabilities\":{}}");
        }, "CezarMobile/0.1.0 (android)");
        probe.probe(origin(), null, null, null);
        assertNull(seen.get("Authorization"));
        assertEquals("CezarMobile/0.1.0 (android)", seen.get("User-Agent"));
        probe.probe(origin(), "me", "secret", "sso=1");
        assertEquals("Basic bWU6c2VjcmV0", seen.get("Authorization"));
        assertEquals("sso=1", seen.get("Cookie"));
    }

    @Test
    public void asksTheHealthRouteOfTheOrigin() throws Exception {
        AtomicReference<String> asked = new AtomicReference<>();
        new HealthProbe((url, headers) -> {
            asked.set(url);
            return HealthClassifierTest.answer(500, null, null, "");
        }, "ua").probe(ServerOrigin.parse("https://cezar.example.com:8443"), null, null, null);
        assertEquals("https://cezar.example.com:8443/api/v1/health", asked.get());
    }

    @Test
    public void tlsAndNetworkFailuresStayApart() throws Exception {
        HealthProbe tls = new HealthProbe((url, headers) -> {
            throw new SSLHandshakeException("bad certificate");
        }, "ua");
        assertEquals(HealthAnswer.Kind.TLS_FAILURE, tls.probe(origin(), null, null, null).kind);
        HealthProbe offline = new HealthProbe((url, headers) -> {
            throw new IOException("no route");
        }, "ua");
        assertEquals(HealthAnswer.Kind.UNREACHABLE, offline.probe(origin(), null, null, null).kind);
    }

    @Test
    public void aChallengeFreeRefusalIsNotAnOutage() throws Exception {
        HealthProbe probe = new HealthProbe((url, headers) -> {
            throw new java.net.ProtocolException("No authentication challenges found");
        }, "ua");
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, probe.probe(origin(), null, null, null).kind);
    }

    @Test
    public void theRealTransportDoesNotFollowARedirect() throws Exception {
        AtomicInteger followed = new AtomicInteger();
        String base = serve("HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", followed);
        HttpAnswer answer = new HttpGet.Platform(false).get(base + "/api/v1/health", Collections.<String, String>emptyMap());
        assertEquals(302, answer.status);
        assertEquals(0, followed.get());
    }

    @Test
    public void theRealTransportReadsAnErrorBodyAndHeaders() throws Exception {
        String body = "{\"error\":\"unexpected Host header\"}";
        String base = serve("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: " + body.length() + "\r\nConnection: close\r\n\r\n" + body, new AtomicInteger());
        HttpAnswer answer = new HttpGet.Platform(false).get(base + "/", Collections.<String, String>emptyMap());
        assertEquals("x", HealthClassifier.classify(answer).realm);
        assertTrue(answer.body.contains("Host header"));
    }

    @Test
    public void theProductionTransportRefusesCleartext() {
        try {
            new HttpGet.Platform().get("http://127.0.0.1:1/", Collections.<String, String>emptyMap());
            assertFalse("expected a refusal", true);
        } catch (IOException e) {
            assertEquals("https only", e.getMessage());
        }
    }
}
