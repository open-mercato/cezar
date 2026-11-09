package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.HttpAnswer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/** `/workspace/phone/push` as cezar answers it inside the session. */
final class FakeCezar implements CezarPush.Http {
    final List<String> calls = new ArrayList<>();
    final List<String> bodies = new ArrayList<>();
    boolean available = true;
    boolean offline;
    /** cezar turned push off between the GET and the PUT. */
    boolean refusePut;
    /** The session drops between the GET and the PUT. */
    boolean dropOnPut;
    String grantId;
    String managerId;

    CezarPush api() {
        return new CezarPush(this, "CezarMobile/test (android)");
    }

    @Override
    public HttpAnswer send(String method, String path, Map<String, String> headers, byte[] body) throws IOException {
        calls.add(method + " " + path);
        if (offline || (dropOnPut && method.equals("PUT"))) throw new IOException("no session");
        if (body != null) bodies.add(new String(body, StandardCharsets.UTF_8));
        try {
            switch (method) {
                case "PUT":
                    if (!available || refusePut) return answer(409, "{\"error\":\"push is off\"}");
                    grantId = new JSONObject(bodies.get(bodies.size() - 1)).getString("grantId");
                    return state();
                case "DELETE":
                    grantId = null;
                    return answer(200, "{\"ok\":true}");
                default:
                    return state();
            }
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        }
    }

    private HttpAnswer state() throws org.json.JSONException {
        JSONObject body = new JSONObject().put("available", available);
        if (available) body.put("cezarKey", GrantClientTest.CEZAR_KEY);
        if (grantId != null) body.put("grantId", grantId).put("grantExpiresAt", 1_807_776_000L);
        if (managerId != null) body.put("managerId", managerId);
        return answer(200, body.toString());
    }

    private static HttpAnswer answer(int status, String body) {
        return new HttpAnswer(status, Collections.<String, List<String>>emptyMap(), body);
    }
}
