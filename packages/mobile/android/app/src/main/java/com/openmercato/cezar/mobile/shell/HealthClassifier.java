package com.openmercato.cezar.mobile.shell;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/** Maps a raw health response onto the spec's add-server table. Network-free. */
public final class HealthClassifier {
    private static final Pattern BASIC = Pattern.compile("^\\s*basic\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern REALM = Pattern.compile("realm=(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^\\s,]+))", Pattern.CASE_INSENSITIVE);

    private HealthClassifier() {}

    public static HealthAnswer classify(HttpAnswer http) {
        int status = http.status;
        if (status == 401) {
            for (String challenge : http.headers("www-authenticate")) {
                if (BASIC.matcher(challenge).find()) {
                    return new HealthAnswer(HealthAnswer.Kind.BASIC_GATE, status, realmOf(challenge), null, null);
                }
            }
        }
        JSONObject json = parseObject(http.body);
        if (status == 200 && json != null) {
            String version = json.optString("version", "");
            JSONObject capabilities = json.optJSONObject("capabilities");
            if (version.isEmpty() || capabilities == null) return HealthAnswer.of(HealthAnswer.Kind.NOT_CEZAR, status);
            Boolean managers = capabilities.opt("managers") instanceof Boolean ? capabilities.optBoolean("managers") : null;
            return new HealthAnswer(HealthAnswer.Kind.CEZAR, status, null, version, managers);
        }
        // server.ts answers `{ error: 'unexpected Host header' }` on a local-mode cockpit.
        if (status == 403 && json != null && json.optString("error", "").toLowerCase(Locale.ROOT).contains("host header")) {
            return HealthAnswer.of(HealthAnswer.Kind.LOCAL_MODE, status);
        }
        boolean redirect = status >= 300 && status < 400;
        boolean htmlGate = (status == 200 || status == 401 || status == 403) && isHtml(http);
        if (redirect || htmlGate) return HealthAnswer.of(HealthAnswer.Kind.LOGIN_PAGE, status);
        return HealthAnswer.of(HealthAnswer.Kind.NOT_CEZAR, status);
    }

    private static boolean isHtml(HttpAnswer http) {
        List<String> types = http.headers("content-type");
        return !types.isEmpty() && types.get(0).toLowerCase(Locale.ROOT).contains("text/html");
    }

    private static JSONObject parseObject(String body) {
        if (body == null || !body.trim().startsWith("{")) return null;
        try {
            return new JSONObject(body);
        } catch (JSONException e) {
            return null;
        }
    }

    private static String realmOf(String challenge) {
        Matcher match = REALM.matcher(challenge);
        if (!match.find()) return "";
        String quoted = match.group(1);
        return quoted != null ? quoted.replaceAll("\\\\(.)", "$1") : match.group(2);
    }
}
