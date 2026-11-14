package com.openmercato.cezar.mobile.shell.relay;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Self-certifying ids and relay proofs (RELAY_PROTOCOL.md §§ 2, 3.1). */
public final class RelayIds {
    private static final byte[] ID_LABEL = Bytes.ascii("cezar-relay-id-v1\n");

    private RelayIds() {}

    public static byte[] idBytes(byte[] ed25519Public) {
        return Arrays.copyOf(RelayCrypto.sha256(ID_LABEL, ed25519Public), 16);
    }

    public static String id(byte[] ed25519Public) {
        return Bytes.base64url(idBytes(ed25519Public));
    }

    public static String socketProof(String role, String roomId, String deviceId, long time) {
        return "cezar-relay-v1\n" + role + "\n" + roomId + "\n" + deviceId + "\n" + time;
    }

    public static String postProof(String path, byte[] body, long time) {
        StringBuilder hex = new StringBuilder();
        for (byte b : RelayCrypto.sha256(body)) hex.append(String.format(Locale.ROOT, "%02x", b));
        return "cezar-relay-post-v1\n" + path + "\n" + hex + "\n-\n" + time;
    }

    public static String sign(byte[] ed25519Seed, String proof) {
        return Bytes.base64url(RelayCrypto.ed25519Sign(ed25519Seed, Bytes.utf8(proof)));
    }

    /** The three proof headers for a phone socket. */
    public static Map<String, String> phoneHeaders(byte[] ed25519Seed, String cezarId, String deviceId, long time) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-Cezar-Relay-Key", Bytes.base64url(RelayCrypto.ed25519Public(ed25519Seed)));
        headers.put("X-Cezar-Relay-Time", Long.toString(time));
        headers.put("X-Cezar-Relay-Sig", sign(ed25519Seed, socketProof("phone", cezarId, deviceId, time)));
        return headers;
    }
}
