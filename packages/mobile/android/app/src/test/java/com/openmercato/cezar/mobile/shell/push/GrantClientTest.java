package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.openmercato.cezar.mobile.shell.relay.Bytes;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import com.openmercato.cezar.mobile.shell.relay.RelayCrypto;
import com.openmercato.cezar.mobile.shell.relay.RelayIds;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONObject;
import org.junit.Test;

/** RELAY_PROTOCOL.md §§ 3.1 and 7, as the phone sends them. */
public class GrantClientTest {
    static final String CEZAR_KEY = Bytes.base64url(RelayCrypto.ed25519Public(new byte[32]));
    static final String GRANT_ID = "AAAAAAAAAAAAAAAAAAAAAA";
    private static final long NOW = 1_800_000_000_000L;

    private final DeviceKeys keys = DeviceKeys.generate();
    private final FakeRelay relay = new FakeRelay();
    private long clock = NOW;
    private final GrantClient client = new GrantClient(relay, () -> clock);

    @Test
    public void theGrantBodyHasExactlyTheThreeKeys() throws Exception {
        relay.answer(200, FakeRelay.grant(GRANT_ID, 1_807_776_000L));
        client.obtain("https://relay.example.test", keys, "fcm:token-1", CEZAR_KEY);
        FakeRelay.Sent sent = relay.sent.get(0);
        assertEquals("https://relay.example.test/v1/push-grants", sent.url);
        String text = new String(sent.body, StandardCharsets.UTF_8);
        assertEquals("{\"platform\":\"android\",\"token\":\"fcm:token-1\",\"cezarKey\":\"" + CEZAR_KEY + "\"}", text);
        JSONObject body = new JSONObject(text);
        Set<String> names = new HashSet<>();
        for (Iterator<String> it = body.keys(); it.hasNext(); ) names.add(it.next());
        assertEquals(new HashSet<>(java.util.Arrays.asList("platform", "token", "cezarKey")), names);
        assertEquals("application/json", sent.headers.get("Content-Type"));
    }

    @Test
    public void theSignatureVerifiesAgainstThePostProofString() throws Exception {
        relay.answer(200, FakeRelay.grant(GRANT_ID, 1_807_776_000L));
        client.obtain("https://relay.example.test", keys, "tok", CEZAR_KEY);
        FakeRelay.Sent sent = relay.sent.get(0);
        byte[] publicKey = Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Key"), 32);
        assertEquals(keys.deviceId(), RelayIds.id(publicKey));
        assertEquals(Long.toString(NOW / 1000), sent.headers.get("X-Cezar-Relay-Time"));
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(sent.body)) hex.append(String.format("%02x", b));
        String proof = "cezar-relay-post-v1\n/v1/push-grants\n" + hex + "\n-\n" + NOW / 1000;
        assertTrue(verify(publicKey, proof, sent.headers.get("X-Cezar-Relay-Sig")));
        assertFalse("bound to the path", verify(publicKey, proof.replace("/v1/push-grants", "/v1/push"), sent.headers.get("X-Cezar-Relay-Sig")));
    }

    @Test
    public void theRevokeIsSignedOverItsOwnPathAndBody() throws Exception {
        relay.answer(204, "");
        assertEquals(GrantClient.Revoke.DONE, client.revoke("https://relay.example.test", keys, "sealed").outcome);
        FakeRelay.Sent sent = relay.sent.get(0);
        assertEquals("https://relay.example.test/v1/push-grants/revoke", sent.url);
        assertEquals("{\"grant\":\"sealed\"}", new String(sent.body, StandardCharsets.UTF_8));
        String proof = RelayIds.postProof("/v1/push-grants/revoke", sent.body, NOW / 1000);
        assertTrue(verify(Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Key"), 32), proof, sent.headers.get("X-Cezar-Relay-Sig")));
    }

    @Test
    public void theRevokeTable() {
        Object[][] rows = {
            {204, GrantClient.Revoke.DONE}, {400, GrantClient.Revoke.STOPPED}, {401, GrantClient.Revoke.STOPPED},
            {410, GrantClient.Revoke.STOPPED}, {429, GrantClient.Revoke.RETRY}, {503, GrantClient.Revoke.RETRY},
            {200, GrantClient.Revoke.RETRY}, {500, GrantClient.Revoke.RETRY}, {404, GrantClient.Revoke.RETRY},
        };
        for (Object[] row : rows) {
            GrantClient.RevokeAnswer answer = GrantClient.classify(new PushRelay.Answer((Integer) row[0], null, 7, -1, ""));
            assertEquals("status " + row[0], row[1], answer.outcome);
        }
        assertEquals(7, GrantClient.classify(new PushRelay.Answer(429, "rate-limited", 7, -1, "")).retryAfter);
        assertEquals("a network failure is retried", GrantClient.Revoke.RETRY, client.revoke("https://relay.example.test", keys, "g").outcome);
    }

    @Test
    public void a401IsRetriedOnceWithTheRelaysClock() throws Exception {
        long relayNow = NOW + 300_000;
        relay.answer(new PushRelay.Answer(401, "bad-proof", -1, relayNow, "{\"code\":\"bad-proof\"}"));
        relay.answer(204, "");
        assertEquals(GrantClient.Revoke.DONE, client.revoke("https://relay.example.test", keys, "g").outcome);
        assertEquals(2, relay.sent.size());
        assertEquals(Long.toString(relayNow / 1000), relay.sent.get(1).headers.get("X-Cezar-Relay-Time"));
        relay.answer(new PushRelay.Answer(401, "bad-proof", -1, relayNow, "")).answer(new PushRelay.Answer(401, "bad-proof", -1, relayNow, ""));
        assertEquals(GrantClient.Revoke.STOPPED, client.revoke("https://relay.example.test", keys, "g").outcome);
        assertEquals("once, never a loop", 4, relay.sent.size());
    }

    @Test
    public void aMalformedGrantIsRefused() {
        String[] bodies = {"{}", "{\"grant\":\"g\",\"grantId\":\"short\",\"expiresAt\":1}", "{\"grant\":\"\",\"grantId\":\"" + GRANT_ID + "\",\"expiresAt\":1}", "nope"};
        for (String body : bodies) {
            relay.answer(200, body);
            try {
                client.obtain("https://relay.example.test", keys, "tok", CEZAR_KEY);
                fail(body);
            } catch (GrantClient.Failure expected) {
                assertFalse("never quotes the token", expected.getMessage().contains("tok"));
            }
        }
    }

    @Test
    public void noRequestWithoutATokenOrWithABadCezarKey() {
        for (String[] row : new String[][] {{null, CEZAR_KEY}, {"", CEZAR_KEY}, {"tok", "not-a-key"}, {"tok", null}}) {
            try {
                client.obtain("https://relay.example.test", keys, row[0], row[1]);
                fail();
            } catch (GrantClient.Failure expected) {
                // expected
            }
        }
        assertTrue(relay.sent.isEmpty());
    }

    private static boolean verify(byte[] publicKey, String proof, String signature) {
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
        byte[] message = proof.getBytes(StandardCharsets.UTF_8);
        signer.update(message, 0, message.length);
        return signer.verifySignature(Bytes.fromBase64url(signature, 64));
    }
}
