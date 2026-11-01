package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

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
}
