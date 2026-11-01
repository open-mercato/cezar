package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The socket state machine against a fake transport, with a real `KK` responder on the far side. */
public class RelayLinkTest {
    private static final class Fake implements SocketTransport {
        final LinkedBlockingQueue<Socket> sockets = new LinkedBlockingQueue<>();

        @Override
        public Connection connect(String url, Map<String, String> headers, Events events) {
            Socket socket = new Socket(url, headers, events);
            sockets.add(socket);
            return socket;
        }
    }

    private static final class Socket implements SocketTransport.Connection {
        final String url;
        final Map<String, String> headers;
        final SocketTransport.Events events;
        final LinkedBlockingQueue<byte[]> binary = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<Integer> closes = new LinkedBlockingQueue<>();

        Socket(String url, Map<String, String> headers, SocketTransport.Events events) {
            this.url = url;
            this.headers = headers;
            this.events = events;
        }

        @Override public boolean sendText(String text) {
            return true;
        }

        @Override public boolean sendBinary(byte[] bytes) {
            binary.add(bytes);
            return true;
        }

        @Override public void close(int code) {
            closes.add(code);
        }
    }

    private final Fake fake = new Fake();
    private final DeviceKeys keys = DeviceKeys.generate();
    private final byte[] cezarSecret = RelayCrypto.x25519Secret();
    private final byte[] cezarEd = RelayCrypto.random(32);
    private final String cezarId = RelayIds.id(RelayCrypto.ed25519Public(cezarEd));
    private final List<RelayStatus.Kind> seen = Collections.synchronizedList(new ArrayList<RelayStatus.Kind>());
    private RelayLink link;

    @Before
    public void build() {
        link = new RelayLink(fake, new RelayLink.Target("ws://127.0.0.1:1", cezarId, keys.deviceId(), RelayCrypto.x25519Public(cezarSecret), keys), System::currentTimeMillis);
        link.setListener(status -> seen.add(status.kind));
    }

    @After
    public void stop() {
        link.stop();
    }

    private Socket opened() throws Exception {
        Socket socket = fake.sockets.poll(3, TimeUnit.SECONDS);
        assertNotNull("a socket opens", socket);
        socket.events.opened();
        return socket;
    }

    private void waitFor(RelayStatus.Kind kind) throws Exception {
        for (int i = 0; i < 200 && link.status().kind != kind; i++) Thread.sleep(10);
        assertEquals(kind, link.status().kind);
    }

    private NoiseHandshake.Keys answerHandshake(Socket socket) throws Exception {
        byte[] first = socket.binary.poll(3, TimeUnit.SECONDS);
        assertNotNull("a KK first message", first);
        assertEquals(49, first.length);
        assertEquals(1, first[0]);
        byte[] prologue = Bytes.concat(Bytes.ascii("cezar-session-v1"), Bytes.fromBase64url(cezarId), Bytes.fromBase64url(keys.deviceId()));
        NoiseHandshake responder = NoiseHandshake.forVector("KK", false, prologue, cezarSecret, RelayCrypto.x25519Public(keys.x25519Secret), null, RelayCrypto.x25519Secret());
        assertEquals(0, responder.readMessage(Arrays.copyOfRange(first, 1, first.length)).length);
        byte[] reply = responder.writeMessage(TunnelRecord.pad(Bytes.utf8("{\"tunnel\":{\"min\":1,\"max\":1}}")));
        socket.events.binary(Bytes.concat(new byte[] {1}, reply));
        return responder.split();
    }

    private static TunnelFrame frame(NoiseHandshake.Keys cezar, byte[] wire) throws Exception {
        return TunnelFrame.parse(TunnelRecord.unpad(cezar.receive.decrypt(Arrays.copyOfRange(wire, 1, wire.length))));
    }

    @Test
    public void theFirstSocketProvesAndWaitsForHello() throws Exception {
        link.start();
        Socket socket = opened();
        assertEquals("ws://127.0.0.1:1/v1/phone/" + cezarId + "/" + keys.deviceId(), socket.url);
        String time = socket.headers.get("X-Cezar-Relay-Time");
        String proof = RelayIds.socketProof("phone", cezarId, keys.deviceId(), Long.parseLong(time));
        assertTrue(RelayCrypto.ed25519Verify(keys.relayKey(), Bytes.utf8(proof), Bytes.fromBase64url(socket.headers.get("X-Cezar-Relay-Sig"))));
        assertNull("nothing before hello", socket.binary.poll(100, TimeUnit.MILLISECONDS));
    }

    @Test
    public void helloOnlineRunsKkThenHelloThenLease() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":65552},\"cezar\":\"online\"}");
        NoiseHandshake.Keys cezar = answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        assertEquals(TunnelFrame.HELLO, frame(cezar, socket.binary.poll(2, TimeUnit.SECONDS)).type);
        assertEquals(TunnelFrame.LEASE, frame(cezar, socket.binary.poll(2, TimeUnit.SECONDS)).type);
        assertNotNull(link.session());
    }

    @Test
    public void helloOfflineSaysSoAndSendsNothing() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"offline\"}");
        waitFor(RelayStatus.Kind.CEZAR_OFFLINE);
        assertNull(socket.binary.poll(100, TimeUnit.MILLISECONDS));
    }

    @Test
    public void offlineEndsTheSessionAndKeepsTheSocketThenOnlineHandshakesAgain() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}");
        answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        TunnelSession first = link.session();
        socket.events.text("{\"t\":\"cezar-offline\"}");
        waitFor(RelayStatus.Kind.CEZAR_OFFLINE);
        assertFalse(first.live());
        assertNull(link.session());
        assertTrue("the socket stays", socket.closes.isEmpty());
        socket.binary.clear();
        socket.events.text("{\"t\":\"cezar-online\"}");
        answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        assertTrue(link.session().live());
    }

    @Test
    public void closeAndRefusalTable() throws Exception {
        Object[][] rows = {
            {4403, RelayStatus.Kind.DEVICE_REMOVED}, {4426, RelayStatus.Kind.UPDATE_APP}, {4400, RelayStatus.Kind.BROKEN}, {4413, RelayStatus.Kind.BROKEN},
        };
        for (Object[] row : rows) {
            link.retryNow();
            Socket socket = opened();
            socket.events.closed((Integer) row[0]);
            waitFor((RelayStatus.Kind) row[1]);
            assertNull("stops reconnecting", fake.sockets.poll(50, TimeUnit.MILLISECONDS));
        }
        link.retryNow();
        fake.sockets.poll(3, TimeUnit.SECONDS).events.failed(403, "device-removed", -1, -1);
        waitFor(RelayStatus.Kind.DEVICE_REMOVED);
    }

    @Test
    public void replacedDoesNothing() throws Exception {
        link.start();
        opened().events.closed(4409);
        waitFor(RelayStatus.Kind.IDLE);
        assertNull(fake.sockets.poll(50, TimeUnit.MILLISECONDS));
    }

    @Test
    public void quotaNamesItsWait() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"closing\",\"retryAfter\":600}");
        socket.events.closed(4430);
        waitFor(RelayStatus.Kind.QUOTA);
        assertEquals(600, link.status().retryAfterSeconds);
    }

    @Test
    public void aLostSocketIsARelayOutageAndReconnects() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.closed(1001);
        waitFor(RelayStatus.Kind.RELAY_DOWN);
        assertNotNull("reconnects within the first jitter window", fake.sockets.poll(3, TimeUnit.SECONDS));
    }

    @Test
    public void aBadProofRetriesOnceCorrectedByDateThenStops() throws Exception {
        link.start();
        long relayNow = System.currentTimeMillis() + 3600000;
        fake.sockets.poll(3, TimeUnit.SECONDS).events.failed(401, "bad-proof", -1, relayNow);
        Socket second = fake.sockets.poll(3, TimeUnit.SECONDS);
        assertNotNull(second);
        long sent = Long.parseLong(second.headers.get("X-Cezar-Relay-Time"));
        assertTrue(Math.abs(sent - relayNow / 1000) < 5);
        second.events.failed(401, "bad-proof", -1, relayNow);
        waitFor(RelayStatus.Kind.BROKEN);
    }

    @Test
    public void aRelayUnderTheFrameFloorIsBroken() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"limits\":{\"frameBytes\":1024},\"cezar\":\"online\"}");
        waitFor(RelayStatus.Kind.BROKEN);
        assertEquals(Integer.valueOf(1000), socket.closes.poll(1, TimeUnit.SECONDS));
    }

    @Test
    public void aTamperedFrameEndsTheSessionAndTheSocket() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}");
        answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        socket.events.binary(new byte[] {1, 2, 3});
        assertEquals(Integer.valueOf(1000), socket.closes.poll(2, TimeUnit.SECONDS));
        assertNull(link.session());
    }

    @Test
    public void noSharedTunnelVersionNamesWhoIsOld() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}");
        byte[] first = socket.binary.poll(3, TimeUnit.SECONDS);
        byte[] prologue = Bytes.concat(Bytes.ascii("cezar-session-v1"), Bytes.fromBase64url(cezarId), Bytes.fromBase64url(keys.deviceId()));
        NoiseHandshake responder = NoiseHandshake.forVector("KK", false, prologue, cezarSecret, RelayCrypto.x25519Public(keys.x25519Secret), null, RelayCrypto.x25519Secret());
        responder.readMessage(Arrays.copyOfRange(first, 1, first.length));
        byte[] json = new JSONObject("{\"tunnel\":{\"min\":2,\"max\":3}}").toString().getBytes(StandardCharsets.UTF_8);
        socket.events.binary(Bytes.concat(new byte[] {1}, responder.writeMessage(TunnelRecord.pad(json))));
        waitFor(RelayStatus.Kind.UPDATE_APP);
        NoiseHandshake.Keys cezar = responder.split();
        TunnelFrame close = frame(cezar, socket.binary.poll(2, TimeUnit.SECONDS));
        assertEquals(TunnelFrame.CLOSE, close.type);
        assertEquals(TunnelFrame.CLOSE_TUNNEL_UNSUPPORTED, close.code);
    }

    @Test
    public void aStaleFrameDuringTheHandshakeIsDroppedAndTheRealReplyStillWorks() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}");
        for (int i = 0; i < 200 && socket.binary.isEmpty(); i++) Thread.sleep(5);
        socket.events.binary(Bytes.concat(new byte[] {1}, new byte[272]));
        answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        assertTrue(socket.closes.isEmpty());
    }

    @Test
    public void aFrameWithNoSessionIsDropped() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"offline\"}");
        waitFor(RelayStatus.Kind.CEZAR_OFFLINE);
        socket.events.binary(Bytes.concat(new byte[] {1}, new byte[272]));
        Thread.sleep(50);
        assertEquals(RelayStatus.Kind.CEZAR_OFFLINE, link.status().kind);
        assertTrue(socket.closes.isEmpty());
    }

    @Test
    public void aQuotaHelloHasNoCezarKeyAndIsNotOffline() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1}");
        socket.events.text("{\"t\":\"closing\",\"retryAfter\":60}");
        socket.events.closed(4430);
        waitFor(RelayStatus.Kind.QUOTA);
        assertFalse(seen.contains(RelayStatus.Kind.CEZAR_OFFLINE));
    }

    @Test
    public void closeDeviceRemovedReconnectsAndTheRefusalDecides() throws Exception {
        link.start();
        Socket socket = opened();
        socket.events.text("{\"t\":\"hello\",\"protocol\":1,\"cezar\":\"online\"}");
        NoiseHandshake.Keys cezar = answerHandshake(socket);
        waitFor(RelayStatus.Kind.READY);
        socket.events.binary(Bytes.concat(new byte[] {1}, cezar.send.encrypt(TunnelRecord.pad(TunnelFrame.close(TunnelFrame.CLOSE_DEVICE_REMOVED)))));
        assertEquals(Integer.valueOf(1000), socket.closes.poll(2, TimeUnit.SECONDS));
        assertFalse(seen.contains(RelayStatus.Kind.DEVICE_REMOVED));
        Socket next = fake.sockets.poll(3, TimeUnit.SECONDS);
        assertNotNull("it reconnects", next);
        next.events.failed(403, "device-removed", -1, -1);
        waitFor(RelayStatus.Kind.DEVICE_REMOVED);
    }

    @Test
    public void stopClosesWith1000() throws Exception {
        link.start();
        Socket socket = opened();
        link.stop();
        assertEquals(Integer.valueOf(1000), socket.closes.poll(2, TimeUnit.SECONDS));
        waitFor(RelayStatus.Kind.IDLE);
    }
}
