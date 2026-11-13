package com.openmercato.cezar.mobile.shell.relay;

import com.openmercato.cezar.mobile.shell.push.GrantClient;
import com.openmercato.cezar.mobile.shell.push.PushRelay;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's side of the relay account (RELAY_PROTOCOL.md § 18): status and resend, signed by this
 * phone's device key. Confirming is the emailed link's button at the relay, never a call from here.
 */
public final class AccountClient {
    public static final String STATUS_PATH = "/v1/accounts/status";
    public static final String RESEND_PATH = "/v1/accounts/resend";

    /** The relay's status object, reduced to what the app shows. */
    public static final class Status {
        /** `confirmed`, `pending` or `blocked`. */
        public final String state;
        public final String email;
        /** Seconds, or -1 when confirmed. */
        public final long secondsLeft;

        public Status(String state, String email, long secondsLeft) {
            this.state = state;
            this.email = email;
            this.secondsLeft = secondsLeft;
        }
    }

    /** A refused call. `code` is the relay's, or `unreachable`. Holds no secret. */
    public static final class Failure extends Exception {
        public final String code;
        public final int status;
        public final long retryAfter;

        Failure(String code, int status, long retryAfter) {
            super(code);
            this.code = code;
            this.status = status;
            this.retryAfter = retryAfter;
        }
    }

    private final PushRelay relay;
    private final LongSupplier clock;

    public AccountClient(PushRelay relay, LongSupplier clock) {
        this.relay = relay;
        this.clock = clock;
    }

    /** `{ cezar, device }`, the body of every phone-proved account call. */
    public static byte[] phoneBody(String cezarId, String deviceId) {
        return Bytes.utf8("{\"cezar\":" + JSONObject.quote(cezarId) + ",\"device\":" + JSONObject.quote(deviceId) + "}");
    }

    public Status status(String origin, DeviceKeys keys, String cezarId) throws Failure {
        JSONObject body = call(origin, STATUS_PATH, phoneBody(cezarId, keys.deviceId()), keys);
        return parseStatus(body.optJSONObject("status"));
    }

    /** When the new code expires, Unix seconds. */
    public long resend(String origin, DeviceKeys keys, String cezarId) throws Failure {
        return call(origin, RESEND_PATH, phoneBody(cezarId, keys.deviceId()), keys).optLong("expiresAt", 0);
    }

    static Status parseStatus(JSONObject status) throws Failure {
        if (status == null) throw new Failure("bad-answer", 200, -1);
        String state = status.optString("state");
        if (!state.equals("confirmed") && !state.equals("pending") && !state.equals("blocked")) throw new Failure("bad-answer", 200, -1);
        String email = status.isNull("email") ? null : status.optString("email", null);
        long left = status.isNull("secondsLeft") ? -1 : status.optLong("secondsLeft", -1);
        return new Status(state, email, left);
    }

    private JSONObject call(String origin, String path, byte[] body, DeviceKeys keys) throws Failure {
        Map<String, String> headers;
        if (keys != null) {
            headers = GrantClient.proofHeaders(keys, path, body, clock.getAsLong() / 1000);
        } else {
            headers = new LinkedHashMap<>();
            headers.put("Content-Type", "application/json");
        }
        PushRelay.Answer answer;
        try {
            answer = relay.post(origin + path, headers, body);
        } catch (IOException e) {
            throw new Failure("unreachable", 0, -1);
        }
        JSONObject json;
        try {
            json = answer.body == null || answer.body.isEmpty() ? new JSONObject() : new JSONObject(answer.body);
        } catch (JSONException e) {
            json = new JSONObject();
        }
        if (answer.status >= 200 && answer.status < 300) return json;
        String code = json.optString("code", answer.status >= 500 ? "unavailable" : Integer.toString(answer.status));
        throw new Failure(code, answer.status, answer.retryAfter);
    }

    /** What the confirm screen says for a refusal. */
    public static String message(Failure failure) {
        switch (failure.code) {
            case "rate-limited":
                return "Too many tries. Try again later.";
            case "already-confirmed":
                return "This email is already confirmed. Tap Check now.";
            case "no-account":
                return "Your computer has no email set up yet. Enter one in cezar's Settings, under Connect a phone.";
            case "unreachable":
                return "Can't reach the Cezar relay. Check your connection and try again.";
            case "email-unavailable":
                return "The relay could not send the email. Try again later.";
            default:
                return "The relay could not do that right now. Try again later.";
        }
    }
}
