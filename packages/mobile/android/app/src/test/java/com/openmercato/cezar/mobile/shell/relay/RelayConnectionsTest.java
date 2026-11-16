package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.CredentialStore;
import com.openmercato.cezar.mobile.shell.HealthAnswer;
import com.openmercato.cezar.mobile.shell.RelayFields;
import com.openmercato.cezar.mobile.shell.ServerRecord;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class RelayConnectionsTest {
    private static final SocketTransport SILENT = (url, headers, events) -> new SocketTransport.Connection() {
        @Override public boolean sendText(String text) {
            return true;
        }

        @Override public boolean sendBinary(byte[] bytes) {
            return true;
        }

        @Override public void close(int code) { }
    };

    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private DeviceKeyStore keys;
    private RelayConnections connections;

    private static final CredentialStore.Cipher PLAIN = new CredentialStore.Cipher() {
        @Override public byte[] seal(byte[] plain) {
            return plain;
        }

        @Override public byte[] open(byte[] sealed) {
            return sealed;
        }
    };

    @Before
    public void build() {
        keys = new DeviceKeyStore(folder.getRoot(), PLAIN);
        connections = new RelayConnections(SILENT, keys, "ua");
    }

    private ServerRecord paired(String id, DeviceKeys device) {
        keys.put(id, device);
        String key = Bytes.base64url(RelayCrypto.x25519Public(RelayCrypto.x25519Secret()));
        return new ServerRecord(id, "Laptop", new RelayFields("https://relay.example.test", "cezar-id", key, device.deviceId(), 0), null);
    }

    @Test
    public void theSameDeviceKeepsItsLink() {
        ServerRecord server = paired("a", DeviceKeys.generate());
        assertSame(connections.link(server), connections.link(server));
    }

    /** On the emulator: Remove, Pair again, and the cached link kept offering the removed keys. */
    @Test
    public void pairingAgainDropsTheLinkHoldingTheOldKeys() {
        RelayLink old = connections.link(paired("a", DeviceKeys.generate()));
        assertNotSame(old, connections.link(paired("a", DeviceKeys.generate())));
    }

    @Test
    public void aSecondServerClosesTheFirstsListener() throws Exception {
        LoopbackProxy first = connections.openProxy(paired("a", DeviceKeys.generate()));
        int port = first.port();
        LoopbackProxy second = connections.openProxy(paired("b", DeviceKeys.generate()));
        assertNotEquals(first, second);
        try (java.net.Socket probe = new java.net.Socket("127.0.0.1", port)) {
            org.junit.Assert.fail("the first listener is gone");
        } catch (java.net.ConnectException expected) {
            // refused
        }
        assertNotNull(second.cookieValue());
        connections.release();
    }

    @Test
    public void noKeysReadAsARemovedPhone() {
        ServerRecord server = paired("a", DeviceKeys.generate());
        keys.delete("a");
        assertEquals(HealthAnswer.Kind.DEVICE_REMOVED, connections.probe(server).kind);
    }

    /** A finishing view's onDestroy can land after the next view opened. */
    @Test
    public void aFinishedViewLeavesTheNewerViewsConnection() throws Exception {
        ServerRecord server = paired("a", DeviceKeys.generate());
        LoopbackProxy first = connections.openProxy(server);
        LoopbackProxy second = connections.openProxy(server);
        RelayLink link = connections.link(server);
        connections.release(first);
        assertSame(link, connections.link(server));
        new java.net.Socket("127.0.0.1", second.port()).close();
        connections.release(second);
        assertNotSame(link, connections.link(server));
        connections.release();
    }

    /** A probe holds its link for seconds, and the view may release it meanwhile. */
    @Test
    public void aDisposedLinkIgnoresEveryCall() {
        RelayLink link = connections.link(paired("a", DeviceKeys.generate()));
        connections.release();
        link.dispose();
        link.start();
        link.stop();
        link.retryNow();
        link.goodbye();
    }

    /** The device switcher probes the other servers while the one on screen keeps its link. */
    @Test
    public void warmingAnotherServerLeavesTheCurrentLinkAlone() throws Exception {
        ServerRecord current = paired("a", DeviceKeys.generate());
        LoopbackProxy proxy = connections.openProxy(current);
        RelayLink mine = connections.link(current);
        RelayLink other = connections.warm(paired("b", DeviceKeys.generate()));
        assertNotNull(other);
        assertNotSame(mine, other);
        assertSame(mine, connections.link(current));
        assertTrue(connections.holds(proxy));
        assertSame("the current server is never warmed twice", mine, connections.warm(current));
        connections.cool(null);
        assertSame(mine, connections.link(current));
        assertTrue(connections.holds(proxy));
        connections.release();
    }

    /** A switch reuses the warmed tunnel instead of dialling again. */
    @Test
    public void theServerSwitchedToAdoptsItsWarmLink() throws Exception {
        connections.openProxy(paired("a", DeviceKeys.generate()));
        ServerRecord target = paired("b", DeviceKeys.generate());
        RelayLink warm = connections.warm(target);
        connections.cool("b");
        assertTrue(connections.warming("b"));
        connections.openProxy(target);
        assertSame(warm, connections.link(target));
        assertFalse(connections.warming("b"));
        connections.release();
    }

    @Test
    public void closingTheSwitcherStopsEveryWarmLink() {
        connections.warm(paired("b", DeviceKeys.generate()));
        connections.warm(paired("c", DeviceKeys.generate()));
        connections.cool(null);
        assertFalse(connections.warming("b"));
        assertFalse(connections.warming("c"));
    }

    @Test
    public void aWarmLinkWithOldKeysIsNotAdopted() {
        RelayLink stale = connections.warm(paired("b", DeviceKeys.generate()));
        assertNotSame(stale, connections.link(paired("b", DeviceKeys.generate())));
        connections.release();
    }
}
