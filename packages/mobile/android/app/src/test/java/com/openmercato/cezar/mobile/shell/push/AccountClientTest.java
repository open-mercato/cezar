package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.openmercato.cezar.mobile.shell.AccountReminder;
import com.openmercato.cezar.mobile.shell.relay.AccountClient;
import com.openmercato.cezar.mobile.shell.relay.Bytes;
import com.openmercato.cezar.mobile.shell.relay.DeviceKeys;
import com.openmercato.cezar.mobile.shell.relay.RelayIds;
import java.nio.charset.StandardCharsets;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.junit.Test;

/** RELAY_PROTOCOL.md § 18, the phone's three calls and the reminder they feed. */
public class AccountClientTest {
    private static final String ORIGIN = "https://relay.example.test";
    private static final String CEZAR = "AAAAAAAAAAAAAAAAAAAAAA";
    private static final long NOW = 1_800_000_000_000L;
    private static final String PENDING = "{\"account\":\"a1\",\"status\":{\"state\":\"pending\",\"email\":\"me@example.test\",\"termsVersion\":\"2026-11-13\","
            + "\"acceptedAt\":1,\"confirmedAt\":null,\"graceEndsAt\":2,\"secondsLeft\":170000}}";

    private final DeviceKeys keys = DeviceKeys.generate();
    private final FakeRelay relay = new FakeRelay();
    private final AccountClient client = new AccountClient(relay, () -> NOW);

    @Test
    public void statusIsSignedByTheDeviceKeyAndNamesCezarAndDevice() throws Exception {
        relay.answer(200, PENDING);
        AccountClient.Status status = client.status(ORIGIN, keys, CEZAR);
        assertEquals("pending", status.state);
        assertEquals("me@example.test", status.email);
        assertEquals(170000, status.secondsLeft);
        FakeRelay.Sent sent = relay.sent.get(0);
        assertEquals(ORIGIN + "/v1/accounts/status", sent.url);
        String body = new String(sent.body, StandardCharsets.UTF_8);
        assertEquals("{\"cezar\":\"" + CEZAR + "\",\"device\":\"" + keys.deviceId() + "\"}", body);
        Ed25519Signer verifier = new Ed25519Signer();
        verifier.init(false, new Ed25519PublicKeyParameters(Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Key")), 0));
        byte[] proof = Bytes.utf8(RelayIds.postProof("/v1/accounts/status", sent.body, NOW / 1000));
        verifier.update(proof, 0, proof.length);
        assertTrue(verifier.verifySignature(Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Sig"))));
    }

    @Test
    public void aPhoneGetsTheEmailMaskedAndShowsItAsIs() throws Exception {
        relay.answer(200, PENDING.replace("me@example.test", "p***@gmail.com"));
        assertEquals("p***@gmail.com", client.status(ORIGIN, keys, CEZAR).email);
    }

    @Test
    public void resendIsSignedAndNamesCezarAndDevice() throws Exception {
        relay.answer(200, "{\"expiresAt\":1800000900}");
        assertEquals(1800000900L, client.resend(ORIGIN, keys, CEZAR));
        FakeRelay.Sent sent = relay.sent.get(0);
        assertEquals(ORIGIN + "/v1/accounts/resend", sent.url);
        assertEquals("{\"cezar\":\"" + CEZAR + "\",\"device\":\"" + keys.deviceId() + "\"}", new String(sent.body, StandardCharsets.UTF_8));
        assertTrue(sent.headers.containsKey("X-Cezar-Relay-Sig"));
    }

    @Test
    public void refusalsCarryTheRelaysCodeAndAPlainMessage() throws Exception {
        String[][] rows = {
            {"429", "rate-limited", "Too many"},
            {"404", "no-account", "no email set up"}, {"409", "already-confirmed", "already confirmed"},
        };
        for (String[] row : rows) {
            relay.answer(Integer.parseInt(row[0]), "{\"code\":\"" + row[1] + "\"}");
            try {
                client.resend(ORIGIN, keys, CEZAR);
                fail(row[1]);
            } catch (AccountClient.Failure failure) {
                assertEquals(row[1], failure.code);
                assertTrue(AccountClient.message(failure), AccountClient.message(failure).contains(row[2]));
            }
        }
        try {
            client.resend(ORIGIN, keys, CEZAR);
            fail("offline");
        } catch (AccountClient.Failure failure) {
            assertEquals("unreachable", failure.code);
        }
    }

    @Test
    public void statusCarriesSuspendedAndThePhonesOwnTerms() throws Exception {
        relay.answer(200, PENDING);
        AccountClient.Status old = client.status(ORIGIN, keys, CEZAR);
        assertFalse("an older relay says nothing", old.suspended);
        assertNull(old.device);

        relay.answer(200, PENDING.replace("\"secondsLeft\":170000}", "\"secondsLeft\":170000,\"suspended\":true}")
                .replace("}}", "},\"device\":{\"termsVersion\":null,\"acceptedAt\":null,\"graceEndsAt\":5,\"secondsLeft\":4}}"));
        AccountClient.Status status = client.status(ORIGIN, keys, CEZAR);
        assertTrue(status.suspended);
        assertNull(status.device.termsVersion);
        assertNull(status.device.acceptedAt);

        relay.answer(200, PENDING.replace("}}", "},\"device\":{\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1800000000,\"graceEndsAt\":5,\"secondsLeft\":0}}"));
        status = client.status(ORIGIN, keys, CEZAR);
        assertFalse(status.suspended);
        assertEquals("2026-11-13", status.device.termsVersion);
        assertEquals(Long.valueOf(1800000000L), status.device.acceptedAt);
    }

    @Test
    public void deviceTermsIsSignedAndAcceptsTheVersion() throws Exception {
        relay.answer(200, "{\"device\":{\"termsVersion\":\"2026-11-13\",\"acceptedAt\":1800000000,\"graceEndsAt\":5,\"secondsLeft\":0}}");
        AccountClient.Device device = client.deviceTerms(ORIGIN, keys, CEZAR, "2026-11-13");
        assertEquals("2026-11-13", device.termsVersion);
        assertEquals(Long.valueOf(1800000000L), device.acceptedAt);
        FakeRelay.Sent sent = relay.sent.get(0);
        assertEquals(ORIGIN + "/v1/devices/terms", sent.url);
        assertEquals("{\"cezar\":\"" + CEZAR + "\",\"device\":\"" + keys.deviceId() + "\",\"termsVersion\":\"2026-11-13\",\"accepted\":true}",
                new String(sent.body, StandardCharsets.UTF_8));
        Ed25519Signer verifier = new Ed25519Signer();
        verifier.init(false, new Ed25519PublicKeyParameters(Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Key")), 0));
        byte[] proof = Bytes.utf8(RelayIds.postProof("/v1/devices/terms", sent.body, NOW / 1000));
        verifier.update(proof, 0, proof.length);
        assertTrue(verifier.verifySignature(Bytes.fromBase64url(sent.headers.get("X-Cezar-Relay-Sig"))));
    }

    @Test
    public void deviceTermsRefusalsKeepTheCurrentVersion() throws Exception {
        relay.answer(409, "{\"code\":\"terms-outdated\",\"current\":\"2026-12-01\"}");
        try {
            client.deviceTerms(ORIGIN, keys, CEZAR, "2026-11-13");
            fail("outdated");
        } catch (AccountClient.Failure failure) {
            assertEquals("terms-outdated", failure.code);
            assertEquals("2026-12-01", failure.current);
            assertTrue(AccountClient.message(failure).contains("terms changed"));
        }
        relay.answer(404, "{\"code\":\"no-account\"}");
        try {
            client.deviceTerms(ORIGIN, keys, CEZAR, "2026-11-13");
            fail("no-account");
        } catch (AccountClient.Failure failure) {
            assertEquals("no-account", failure.code);
            assertNull(failure.current);
        }
    }

    @Test
    public void theReminderShowsOnlyWhilePending() {
        assertEquals("Confirm your computer's email within 47 h to keep this phone connected.",
                AccountReminder.text(new AccountClient.Status("pending", "me@example.test", 47 * 3600 + 5)));
        assertEquals("3 h 20 min", AccountReminder.timeLeft(3 * 3600 + 20 * 60));
        assertEquals("12 min", AccountReminder.timeLeft(12 * 60));
        assertNull(AccountReminder.text(new AccountClient.Status("confirmed", "me@example.test", -1)));
        assertNull(AccountReminder.text(new AccountClient.Status("blocked", "me@example.test", 0)));
        assertNull(AccountReminder.text(null));
    }
}
