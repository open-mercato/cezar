package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

/** One rendezvous, with a real `XXpsk3` responder as cezar. */
public class PairingClientTest {
    private static final class Fake implements SocketTransport, SocketTransport.Connection {
        final LinkedBlockingQueue<byte[]> binary = new LinkedBlockingQueue<>();
        volatile Events events;
        volatile String url;
        volatile Map<String, String> headers;
        volatile int closed;

        @Override public Connection connect(String target, Map<String, String> sent, Events listener) {
            url = target;
            headers = sent;
            events = listener;
            return this;
        }

        @Override public boolean sendText(String text) {
            return true;
        }

        @Override public boolean sendBinary(byte[] bytes) {
            binary.add(bytes);
            return true;
        }

        @Override public void close(int code) {
            closed = code;
        }
    }

    private final Fake fake = new Fake();
    private final byte[] cezarSecret = RelayCrypto.x25519Secret();
    private final byte[] cezarEd = RelayCrypto.random(32);
    private final LinkedBlockingQueue<PairingClient.State> states = new LinkedBlockingQueue<>();
    private final DeviceKeys keys = DeviceKeys.generate();

    private PairSecret qrSecret(byte[] pinned) throws Exception {
        return PairSecret.fromQr("https://relay.example.test/p#1." + Bytes.base64url(RelayCrypto.random(32)) + "." + Bytes.base64url(pinned), false);
    }

    private PairingClient client(PairSecret secret) throws Exception {
        PairingClient client = new PairingClient(fake, secret, keys, "Pixel\n9", states::add);
        client.start();
        assertEquals(PairingClient.Phase.CONNECTING, states.poll(2, TimeUnit.SECONDS).phase);
        for (int i = 0; i < 200 && fake.events == null; i++) Thread.sleep(5);
        return client;
    }

    private byte[] nextMessage() throws Exception {
        byte[] frame = fake.binary.poll(3, TimeUnit.SECONDS);
        assertNotNull("the phone sent a frame", frame);
        assertEquals(1, frame[0]);
        return Arrays.copyOfRange(frame, 1, frame.length);
    }

    /** Runs cezar's half up to the third message. */
    private NoiseHandshake.Keys handshake(PairSecret secret, NoiseHandshake[] kept, JSONObject[] phone) throws Exception {
        fake.events.text("{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":16384}}");
        assertNull("nothing before peer-joined", fake.binary.poll(50, TimeUnit.MILLISECONDS));
        fake.events.text("{\"t\":\"peer-joined\"}");
        byte[] prologue = Bytes.concat(Bytes.ascii("cezar-pair-v1"), secret.locatorBytes);
        NoiseHandshake responder = NoiseHandshake.forVector("XXpsk3", false, prologue, cezarSecret, null, secret.psk, RelayCrypto.x25519Secret());
        byte[] first = nextMessage();
        assertEquals(48, first.length);
        assertEquals(0, responder.readMessage(first).length);
        byte[] second = responder.writeMessage(new byte[0]);
        assertEquals(96, second.length);
        fake.events.binary(Bytes.concat(new byte[] {1}, second));
        byte[] third = nextMessage();
        phone[0] = new JSONObject(new String(TunnelRecord.unpad(responder.readMessage(third)), StandardCharsets.UTF_8));
        kept[0] = responder;
        return responder.split();
    }

    private void deliver(NoiseHandshake.Keys cezar, String json) {
        fake.events.binary(Bytes.concat(new byte[] {1}, cezar.send.encrypt(TunnelRecord.pad(Bytes.utf8(json)))));
    }

    private String pending() {
        return "{\"t\":\"pending\",\"relayKey\":\"" + Bytes.base64url(RelayCrypto.ed25519Public(cezarEd)) + "\",\"tunnel\":{\"min\":1,\"max\":1},\"label\":\"Test Mac\"}";
    }

    @Test
    public void aFullPairing() throws Exception {
        PairSecret secret = qrSecret(RelayCrypto.x25519Public(cezarSecret));
        client(secret);
        assertTrue(fake.url, fake.url.endsWith("/v1/pair/" + secret.locator() + "?role=phone"));
        assertTrue("role=phone carries no proof", fake.headers.isEmpty());
        NoiseHandshake[] responder = new NoiseHandshake[1];
        JSONObject[] phone = new JSONObject[1];
        NoiseHandshake.Keys cezar = handshake(secret, responder, phone);
        assertEquals("Pixel9", phone[0].getString("name"));
        assertEquals("android", phone[0].getString("platform"));
        assertEquals(Bytes.base64url(keys.relayKey()), phone[0].getString("relayKey"));
        assertArrayEquals(RelayCrypto.x25519Public(keys.x25519Secret), responder[0].remoteStatic());
        deliver(cezar, pending());
        PairingClient.State confirm = states.poll(2, TimeUnit.SECONDS);
        assertEquals(PairingClient.Phase.CONFIRM, confirm.phase);
        assertEquals(PairSecret.sasDigits(responder[0].handshakeHash()), confirm.digits);
        assertEquals("Test Mac", confirm.label);
        assertNull("the phone sends nothing after the third message", fake.binary.poll(50, TimeUnit.MILLISECONDS));
        deliver(cezar, "{\"t\":\"approved\"}");
        PairingClient.State done = states.poll(2, TimeUnit.SECONDS);
        assertEquals(PairingClient.Phase.APPROVED, done.phase);
        assertEquals(RelayIds.id(RelayCrypto.ed25519Public(cezarEd)), done.cezarId);
        assertArrayEquals(RelayCrypto.x25519Public(cezarSecret), done.cezarStatic);
        assertEquals(1000, fake.closed);
    }

    @Test
    public void aWrongPinStopsBeforeTheThirdMessage() throws Exception {
        PairSecret secret = qrSecret(RelayCrypto.x25519Public(RelayCrypto.x25519Secret()));
        client(secret);
        fake.events.text("{\"t\":\"hello\",\"protocol\":1}");
        fake.events.text("{\"t\":\"peer-joined\"}");
        byte[] prologue = Bytes.concat(Bytes.ascii("cezar-pair-v1"), secret.locatorBytes);
        NoiseHandshake responder = NoiseHandshake.forVector("XXpsk3", false, prologue, cezarSecret, null, secret.psk, RelayCrypto.x25519Secret());
        responder.readMessage(nextMessage());
        fake.events.binary(Bytes.concat(new byte[] {1}, responder.writeMessage(new byte[0])));
        PairingClient.State failed = states.poll(2, TimeUnit.SECONDS);
        assertEquals(PairingClient.Phase.FAILED, failed.phase);
        assertEquals("pin-mismatch", failed.reason);
        assertEquals(1000, fake.closed);
        assertNull("the third message is never sent", fake.binary.poll(100, TimeUnit.MILLISECONDS));
    }

    @Test
    public void aTypedCodeHasNoPinAndStillPairs() throws Exception {
        PairSecret secret = PairSecret.fromCode("QRFX-7KMD-2NVB", RelayOrigin.parse("https://relay.example.test", false));
        client(secret);
        NoiseHandshake.Keys cezar = handshake(secret, new NoiseHandshake[1], new JSONObject[1]);
        deliver(cezar, pending());
        assertEquals(PairingClient.Phase.CONFIRM, states.poll(2, TimeUnit.SECONDS).phase);
    }

    @Test
    public void outcomes() throws Exception {
        String[][] rows = {
            {"{\"t\":\"denied\"}", "denied"},
            {"{\"t\":\"failure\",\"reason\":\"device-limit\"}", "device-limit"},
            {"{\"t\":\"failure\",\"reason\":\"something-new\"}", "internal"},
            {"{\"t\":\"failure\",\"reason\":\"tunnel-unsupported\",\"tunnel\":{\"min\":2,\"max\":2}}", "update-app"},
        };
        for (String[] row : rows) {
            states.clear();
            PairSecret secret = qrSecret(RelayCrypto.x25519Public(cezarSecret));
            fake.events = null;
            client(secret);
            deliver(handshake(secret, new NoiseHandshake[1], new JSONObject[1]), row[0]);
            assertEquals(row[0], row[1], states.poll(2, TimeUnit.SECONDS).reason);
        }
    }

    @Test
    public void closeCodesEndTheCode() throws Exception {
        Object[][] rows = {{4404, "not-found"}, {4408, "expired"}, {4410, "taken"}, {4429, "rate-limited"}, {1006, "lost"}};
        for (Object[] row : rows) {
            states.clear();
            fake.events = null;
            client(qrSecret(RelayCrypto.x25519Public(cezarSecret)));
            fake.events.closed((Integer) row[0]);
            assertEquals(row[1], states.poll(2, TimeUnit.SECONDS).reason);
        }
        Object[][] refusals = {{404, "not-found"}, {409, "taken"}, {0, "relay-unreachable"}, {426, "update-app"}};
        for (Object[] row : refusals) {
            states.clear();
            fake.events = null;
            client(qrSecret(RelayCrypto.x25519Public(cezarSecret)));
            fake.events.failed((Integer) row[0], null, -1, -1);
            assertEquals(row[1], states.poll(2, TimeUnit.SECONDS).reason);
        }
    }

    @Test
    public void aPhoneNameIsCutOnACharacterBoundary() {
        StringBuilder name = new StringBuilder();
        for (int i = 0; i < 40; i++) name.append('ż');
        String safe = PairingClient.safeName(name.toString());
        assertEquals(64, Bytes.utf8(safe).length);
        assertEquals("Android phone", PairingClient.safeName("\n\t"));
    }

    /** cezar already holds this phone, so the page must end rather than wait on Confirm for ever. */
    @Test
    public void aSaveThatFailsEndsThePairing() throws Exception {
        String qr = "https://relay.example.test/p#1." + Bytes.base64url(RelayCrypto.random(32)) + "." + Bytes.base64url(RelayCrypto.x25519Public(cezarSecret));
        PairingFlow flow = new PairingFlow(fake, "Pixel", false, (relay, state, device) -> {
            throw new IllegalStateException("disk full");
        });
        PairingFlow.Snapshot seen = flow.startQr(qr);
        for (int i = 0; i < 200 && fake.events == null; i++) Thread.sleep(5);
        NoiseHandshake.Keys cezar = handshake(PairSecret.fromQr(qr, false), new NoiseHandshake[1], new JSONObject[1]);
        deliver(cezar, pending());
        deliver(cezar, "{\"t\":\"approved\"}");
        for (int i = 0; i < 50 && seen.phase != PairingClient.Phase.FAILED; i++) seen = flow.next(seen.seq, 100);
        assertEquals(PairingClient.Phase.FAILED, seen.phase);
        assertEquals("internal", seen.reason);
    }

    @Test
    public void aReplacedPairingCannotReportOverTheNewOne() throws Exception {
        PairingFlow flow = new PairingFlow(fake, "Pixel", false, (relay, state, device) -> { });
        String pin = Bytes.base64url(RelayCrypto.x25519Public(cezarSecret));
        flow.startQr("https://relay.example.test/p#1." + Bytes.base64url(RelayCrypto.random(32)) + "." + pin);
        for (int i = 0; i < 200 && fake.events == null; i++) Thread.sleep(5);
        PairingFlow.Snapshot second = flow.startQr("https://relay.example.test/p#1." + Bytes.base64url(RelayCrypto.random(32)) + "." + pin);
        PairingFlow.Snapshot after = second;
        for (int i = 0; i < 4; i++) after = flow.next(after.seq, 100);
        assertEquals(PairingClient.Phase.CONNECTING, after.phase);
    }

    /** Only the first `pending` names the cezar the six digits were shown for. */
    @Test
    public void aSecondPendingCannotRenameTheComputer() throws Exception {
        PairSecret secret = qrSecret(RelayCrypto.x25519Public(cezarSecret));
        client(secret);
        NoiseHandshake.Keys cezar = handshake(secret, new NoiseHandshake[1], new JSONObject[1]);
        deliver(cezar, pending());
        assertEquals(PairingClient.Phase.CONFIRM, states.poll(2, TimeUnit.SECONDS).phase);
        deliver(cezar, pending().replace("Test Mac", "Other"));
        deliver(cezar, "{\"t\":\"approved\"}");
        assertEquals("Test Mac", states.poll(2, TimeUnit.SECONDS).label);
    }
}
