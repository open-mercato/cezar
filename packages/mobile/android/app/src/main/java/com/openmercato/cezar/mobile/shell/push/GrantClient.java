package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.relay.Bytes;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import com.openmercato.cezar.mobile.shell.relay.RelayCrypto;
import com.openmercato.cezar.mobile.shell.relay.RelayIds;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/** `POST /v1/push-grants` and `/v1/push-grants/revoke`, each signed by the server's device key (RELAY_PROTOCOL.md §§ 3.1, 7). */
public final class GrantClient {
    public static final String GRANTS_PATH = "/v1/push-grants";
    public static final String REVOKE_PATH = "/v1/push-grants/revoke";
    private static final Pattern GRANT_ID = Pattern.compile("[A-Za-z0-9_-]{22}");
    private static final int MAX_GRANT = 4096;
    private static final int MAX_TOKEN = 1024;

    /** Why a grant was not had. Holds no token and no grant, so it is safe to log. */
    public static final class Failure extends Exception {
        public final int status;
        /** Seconds, or -1. */
        public final long retryAfter;

        Failure(String message, int status, long retryAfter) {
            super(message);
            this.status = status;
            this.retryAfter = retryAfter;
        }
    }

    /** The revoke table of § 7. Only `DONE` means the denial is stored. */
    public enum Revoke { DONE, STOPPED, RETRY }

    public static final class RevokeAnswer {
        public final Revoke outcome;
        public final int status;
        /** Seconds, or -1 for full jitter. */
        public final long retryAfter;

        RevokeAnswer(Revoke outcome, int status, long retryAfter) {
            this.outcome = outcome;
            this.status = status;
            this.retryAfter = retryAfter;
        }
    }

    private final PushRelay relay;
    private final LongSupplier clock;
    /** The relay's clock minus ours, learned from a 401's `Date` (§ 3.2). */
    private long skewMs;

    public GrantClient(PushRelay relay, LongSupplier clock) {
        this.relay = relay;
        this.clock = clock;
    }

    /** Exactly the three keys § 7 lists: the relay refuses any other. */
    public static byte[] grantBody(String token, String cezarKey) {
        return Bytes.utf8("{\"platform\":\"android\",\"token\":" + JSONObject.quote(token) + ",\"cezarKey\":" + JSONObject.quote(cezarKey) + "}");
    }

    public static byte[] revokeBody(String grant) {
        return Bytes.utf8("{\"grant\":" + JSONObject.quote(grant) + "}");
    }

    /** The three proof headers for one `POST`. */
    public static Map<String, String> proofHeaders(DeviceKeys keys, String path, byte[] body, long time) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("X-Cezar-Relay-Key", Bytes.base64url(RelayCrypto.ed25519Public(keys.ed25519Seed)));
        headers.put("X-Cezar-Relay-Time", Long.toString(time));
        headers.put("X-Cezar-Relay-Sig", RelayIds.sign(keys.ed25519Seed, RelayIds.postProof(path, body, time)));
        return headers;
    }

    public PushGrant obtain(String origin, DeviceKeys keys, String token, String cezarKey) throws Failure {
        if (token == null || token.isEmpty() || token.length() > MAX_TOKEN) throw new Failure("no usable push token", 0, -1);
        if (Bytes.fromBase64url(cezarKey, 32) == null) throw new Failure("cezar sent no usable key", 0, -1);
        PushRelay.Answer answer;
        try {
            answer = post(origin, GRANTS_PATH, keys, grantBody(token, cezarKey));
        } catch (IOException e) {
            throw new Failure("relay unreachable", 0, -1);
        }
        if (answer.status != 200) throw new Failure("relay answered " + answer.status, answer.status, answer.retryAfter);
        try {
            JSONObject body = new JSONObject(answer.body);
            String grant = body.getString("grant");
            String grantId = body.getString("grantId");
            long expiresAt = body.getLong("expiresAt");
            if (grant.isEmpty() || grant.length() > MAX_GRANT || !GRANT_ID.matcher(grantId).matches() || expiresAt <= 0) {
                throw new Failure("relay sent a bad grant", 200, -1);
            }
            return new PushGrant(grant, grantId, expiresAt, cezarKey, false);
        } catch (JSONException e) {
            throw new Failure("relay sent a bad grant", 200, -1);
        }
    }

    public RevokeAnswer revoke(String origin, DeviceKeys keys, String grant) {
        try {
            return classify(post(origin, REVOKE_PATH, keys, revokeBody(grant)));
        } catch (IOException e) {
            return new RevokeAnswer(Revoke.RETRY, 0, -1);
        }
    }

    /**
     * § 7: keep the grant until 204, 400, 401 or 410, and nothing else. A 404 or 405 may come from a
     * proxy in front of the relay, and stopping on it would drop a forgotten server's key early.
     */
    public static RevokeAnswer classify(PushRelay.Answer answer) {
        switch (answer.status) {
            case 204:
                return new RevokeAnswer(Revoke.DONE, 204, -1);
            case 400:
            case 401:
            case 410:
                return new RevokeAnswer(Revoke.STOPPED, answer.status, -1);
            default:
                return new RevokeAnswer(Revoke.RETRY, answer.status, answer.retryAfter);
        }
    }

    /** Retries a 401 once, correcting the time by the relay's `Date` (§ 3.2). */
    private PushRelay.Answer post(String origin, String path, DeviceKeys keys, byte[] body) throws IOException {
        PushRelay.Answer answer = send(origin, path, keys, body);
        if (answer.status != 401 || answer.date <= 0) return answer;
        long skew = answer.date - clock.getAsLong();
        synchronized (this) {
            skewMs = skew;
        }
        return send(origin, path, keys, body);
    }

    private PushRelay.Answer send(String origin, String path, DeviceKeys keys, byte[] body) throws IOException {
        long skew;
        synchronized (this) {
            skew = skewMs;
        }
        long time = (clock.getAsLong() + skew) / 1000;
        return relay.post(origin + path, proofHeaders(keys, path, body, time), body);
    }
}
