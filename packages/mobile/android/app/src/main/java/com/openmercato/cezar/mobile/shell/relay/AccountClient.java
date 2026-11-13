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
 * The phone's side of the relay account (RELAY_PROTOCOL.md § 18): status, resend and this phone's
 * terms, signed by this phone's device key. Confirming is the emailed link's button at the relay, never a call from here.
 */
public final class AccountClient {
    public static final String STATUS_PATH = "/v1/accounts/status";
    public static final String RESEND_PATH = "/v1/accounts/resend";
    public static final String DEVICE_TERMS_PATH = "/v1/devices/terms";

    /** The relay's status object, reduced to what the app shows. */
    public static final class Status {
        /** `confirmed`, `pending` or `blocked`. */
        public final String state;
        public final String email;
        /** Seconds, or -1 when confirmed. */
        public final long secondsLeft;
        /** False when the relay does not say. */
        public final boolean suspended;
        /** This phone's own terms record; null from an older relay. */
        public final Device device;

        public Status(String state, String email, long secondsLeft) {
            this(state, email, secondsLeft, false, null);
        }

        public Status(String state, String email, long secondsLeft, boolean suspended, Device device) {
            this.state = state;
            this.email = email;
            this.secondsLeft = secondsLeft;
            this.suspended = suspended;
            this.device = device;
        }
    }

    /** The asking phone's terms: both null until it accepted. */
    public static final class Device {
        public final String termsVersion;
        /** Unix seconds, or null. */
        public final Long acceptedAt;

        public Device(String termsVersion, Long acceptedAt) {
            this.termsVersion = termsVersion;
            this.acceptedAt = acceptedAt;
        }
    }

    /** A refused call. `code` is the relay's, or `unreachable`. Holds no secret. */
    public static final class Failure extends Exception {
        public final String code;
        public final int status;
        public final long retryAfter;
        /** The relay's current terms version, on `terms-outdated` only. */
        public final String current;

        Failure(String code, int status, long retryAfter) {
            this(code, status, retryAfter, null);
        }

        Failure(String code, int status, long retryAfter, String current) {
            super(code);
            this.code = code;
            this.status = status;
            this.retryAfter = retryAfter;
            this.current = current;
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
        return parseStatus(body);
    }

    /** `{ cezar, device, termsVersion, accepted: true }`. */
    public static byte[] termsBody(String cezarId, String deviceId, String termsVersion) {
        return Bytes.utf8("{\"cezar\":" + JSONObject.quote(cezarId) + ",\"device\":" + JSONObject.quote(deviceId)
                + ",\"termsVersion\":" + JSONObject.quote(termsVersion) + ",\"accepted\":true}");
    }

    /** Accepts the relay terms for this phone. Does not reconnect: the page opens the server again. */
    public Device deviceTerms(String origin, DeviceKeys keys, String cezarId, String termsVersion) throws Failure {
        JSONObject body = call(origin, DEVICE_TERMS_PATH, termsBody(cezarId, keys.deviceId(), termsVersion), keys);
        if (body.optJSONObject("device") == null) throw new Failure("bad-answer", 200, -1);
        return parseDevice(body.optJSONObject("device"));
    }

    /** When the new code expires, Unix seconds. */
    public long resend(String origin, DeviceKeys keys, String cezarId) throws Failure {
        return call(origin, RESEND_PATH, phoneBody(cezarId, keys.deviceId()), keys).optLong("expiresAt", 0);
    }

    /** The whole answer: `status`, and the phone's own `device` beside it. */
    static Status parseStatus(JSONObject answer) throws Failure {
        JSONObject status = answer.optJSONObject("status");
        if (status == null) throw new Failure("bad-answer", 200, -1);
        String state = status.optString("state");
        if (!state.equals("confirmed") && !state.equals("pending") && !state.equals("blocked")) throw new Failure("bad-answer", 200, -1);
        String email = status.isNull("email") ? null : status.optString("email", null);
        long left = status.isNull("secondsLeft") ? -1 : status.optLong("secondsLeft", -1);
        boolean suspended = status.optBoolean("suspended", false);
        JSONObject device = answer.optJSONObject("device");
        return new Status(state, email, left, suspended, device == null ? null : parseDevice(device));
    }

    static Device parseDevice(JSONObject device) {
        String version = device.isNull("termsVersion") ? null : device.optString("termsVersion", null);
        Long accepted = device.isNull("acceptedAt") || !device.has("acceptedAt") ? null : device.optLong("acceptedAt");
        return new Device(version, accepted);
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
        throw new Failure(code, answer.status, answer.retryAfter, json.isNull("current") ? null : json.optString("current", null));
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
            case "terms-outdated":
                return "The relay's terms changed. Read the new terms and accept them again.";
            case "terms-required":
                return "Accept the relay's terms to keep using this phone with it.";
            case "email-unavailable":
                return "The relay could not send the email. Try again later.";
            default:
                return "The relay could not do that right now. Try again later.";
        }
    }
}
