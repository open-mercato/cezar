package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class HealthClassifierTest {
    static HttpAnswer answer(int status, String contentType, String wwwAuthenticate, String body) {
        Map<String, List<String>> headers = new HashMap<>();
        if (contentType != null) headers.put("content-type", Arrays.asList(contentType));
        if (wwwAuthenticate != null) headers.put("www-authenticate", Arrays.asList(wwwAuthenticate));
        return new HttpAnswer(status, headers, body);
    }

    private static HealthAnswer classify(int status, String contentType, String auth, String body) {
        return HealthClassifier.classify(answer(status, contentType, auth, body));
    }

    @Test
    public void readsManagersAndVersion() {
        HealthAnswer on = classify(200, "application/json", null, "{\"version\":\"0.18.0\",\"capabilities\":{\"managers\":true}}");
        assertEquals(HealthAnswer.Kind.CEZAR, on.kind);
        assertEquals(Boolean.TRUE, on.managers);
        assertEquals("0.18.0", on.version);
        assertEquals(Boolean.FALSE, classify(200, "application/json", null, "{\"version\":\"1\",\"capabilities\":{\"managers\":false}}").managers);
    }

    @Test
    public void absentCapabilityStaysDistinctFromFalse() {
        assertNull(classify(200, "application/json", null, "{\"version\":\"0.9\",\"capabilities\":{}}").managers);
    }

    @Test
    public void jsonThatIsNotCezarIsSaidToBeSo() {
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, classify(200, "application/json", null, "{\"status\":\"ok\"}").kind);
    }

    @Test
    public void basicGateKeepsItsRealm() {
        HealthAnswer gate = classify(401, "text/html", "Basic realm=\"cezar \\\"box\\\"\", charset=\"UTF-8\"", "<html>");
        assertEquals(HealthAnswer.Kind.BASIC_GATE, gate.kind);
        assertEquals("cezar \"box\"", gate.realm);
        assertEquals("ngrok", classify(401, null, "basic realm=ngrok", "").realm);
        assertEquals("", classify(401, null, "Basic", "").realm);
    }

    @Test
    public void bearerChallengeIsNotABasicGate() {
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, classify(401, "application/json", "Bearer", "{}").kind);
    }

    @Test
    public void localModeIsTheHostHeader403Only() {
        assertEquals(HealthAnswer.Kind.LOCAL_MODE, classify(403, "application/json", null, "{\"error\":\"unexpected Host header\"}").kind);
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, classify(403, "application/json", null, "{\"error\":\"nope\"}").kind);
    }

    @Test
    public void redirectOrHtmlIsALoginPage() {
        assertEquals(HealthAnswer.Kind.LOGIN_PAGE, classify(302, null, null, "").kind);
        assertEquals(HealthAnswer.Kind.LOGIN_PAGE, classify(200, "text/html; charset=utf-8", null, "<html>").kind);
    }

    @Test
    public void anythingElseKeepsItsStatus() {
        HealthAnswer other = classify(500, "text/html", null, "<html>");
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, other.kind);
        assertEquals(500, other.status);
        assertEquals(HealthAnswer.Kind.NOT_CEZAR, classify(200, "application/json", null, "not json").kind);
        assertTrue(classify(404, "text/html", null, "<html>").kind == HealthAnswer.Kind.NOT_CEZAR);
    }
}
