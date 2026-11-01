package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The relay kind of server: storage, gates, the start table and the banner. The Manual path has its own tests. */
public class RelayServerTest {
    private static final HttpAnswer CEZAR = HealthClassifierTest.answer(200, "application/json", null, "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}");

    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private ServerListStore servers;
    private HealthAnswer nextHealth;
    private final List<String> calls = new ArrayList<>();
    private ShellConnector connector;

    private final RelayFields fields = new RelayFields("https://relay.example.test", "cezar-id", "key", "device-id", 0);

    @Before
    public void build() {
        servers = new ServerListStore(folder.getRoot());
        CredentialStore credentials = new CredentialStore(folder.getRoot(), new CredentialStore.Cipher() {
            @Override public byte[] seal(byte[] plain) {
                return plain;
            }

            @Override public byte[] open(byte[] sealed) {
                return sealed;
            }
        });
        connector = new ShellConnector(servers, credentials, new HealthProbe((url, headers) -> {
            throw new AssertionError("a relay server is never probed over https");
        }, "ua"), new ShellConnector.RelayPort() {
            @Override public HealthAnswer probe(ServerRecord server) {
                calls.add("probe");
                return nextHealth;
            }

            @Override public void goodbye(ServerRecord server) {
                calls.add("goodbye");
            }

            @Override public void forgetKeys(String id) {
                calls.add("forgetKeys");
            }
        });
    }

    @Test
    public void aRelayServerRoundTripsWithNoUrlOrPassword() throws IOException {
        String id = connector.saveRelayServer("Laptop", fields);
        connector.saveRelayPort(id, 4242);
        ServerRecord server = new ServerListStore(folder.getRoot()).get(id);
        assertNull(server.url);
        assertNull(server.username);
        assertEquals("https://relay.example.test", server.relay.origin);
        assertEquals(4242, server.relay.port);
        String file = new String(Files.readAllBytes(new File(folder.getRoot(), "servers.json").toPath()), StandardCharsets.UTF_8);
        assertFalse(file, file.contains("\"url\""));
    }

    @Test
    public void pairingTheSameCezarAgainKeepsItsRowAndPort() {
        String id = connector.saveRelayServer("Laptop", fields);
        connector.saveRelayPort(id, 4242);
        assertEquals(id, connector.saveRelayServer("Renamed", new RelayFields("https://other.example.test", "cezar-id", "new-key", "device-2", 0)));
        ServerRecord server = servers.get(id);
        assertEquals("Renamed", server.label);
        assertEquals(4242, server.relay.port);
        assertEquals("device-2", server.relay.deviceId);
        assertEquals(1, servers.list().size());
    }

    @Test
    public void aManualServerStaysFindableBesideARelayOne() {
        connector.saveRelayServer("Laptop", fields);
        servers.put(new ServerRecord("m", "Box", "https://box.example.com", null, null, null));
        assertEquals("m", servers.findByUrl("https://box.example.com").id);
        assertNull(servers.findByCezarId("nope"));
        assertEquals(2, servers.list().size());
    }

    @Test
    public void theStartTableOpensThePathNotAUrl() throws Exception {
        String id = connector.saveRelayServer("Laptop", fields);
        nextHealth = HealthClassifier.classify(CEZAR);
        ShellConnector.Outcome outcome = connector.open(id, null);
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertEquals("/manager", outcome.url);
    }

    @Test
    public void relayRoutes() {
        String id = connector.saveRelayServer("Laptop", fields);
        Object[][] rows = {
            {HealthAnswer.Kind.CEZAR_OFFLINE, ShellConnector.CEZAR_OFFLINE}, {HealthAnswer.Kind.RELAY_DOWN, ShellConnector.RELAY_DOWN},
            {HealthAnswer.Kind.QUOTA, ShellConnector.QUOTA}, {HealthAnswer.Kind.DEVICE_REMOVED, ShellConnector.DEVICE_REMOVED},
            {HealthAnswer.Kind.UPDATE_APP, ShellConnector.UPDATE_APP}, {HealthAnswer.Kind.UPDATE_CEZAR, ShellConnector.UPDATE_CEZAR},
            {HealthAnswer.Kind.BASIC_GATE, ShellConnector.CONNECTION_ERROR}, {HealthAnswer.Kind.NOT_CEZAR, ShellConnector.CONNECTION_ERROR},
        };
        for (Object[] row : rows) {
            nextHealth = HealthAnswer.of((HealthAnswer.Kind) row[0], 0);
            ShellConnector.Outcome outcome = connector.open(id, null);
            assertEquals(row[1], outcome.screen);
            assertNull(outcome.url);
        }
    }

    @Test
    public void connectingPastTheWaitReadsAsTheRelayNeverTheComputer() {
        assertEquals(HealthAnswer.Kind.RELAY_DOWN, HealthAnswer.fromRelay("CONNECTING", 0).kind);
        assertEquals(HealthAnswer.Kind.RELAY_DOWN, HealthAnswer.fromRelay("RELAY_DOWN", 0).kind);
        assertEquals(StartDecision.Route.RELAY_DOWN, StartDecision.decide(HealthAnswer.of(HealthAnswer.Kind.RELAY_DOWN, 0), false));
    }

    @Test
    public void forgetSaysGoodbyeBeforeTheKeysGo() {
        String id = connector.saveRelayServer("Laptop", fields);
        connector.forget(id);
        assertEquals("[goodbye, forgetKeys]", calls.toString());
        assertNull(servers.get(id));
    }

    @Test
    public void proxyOriginIsExact() {
        ProxyOrigin origin = new ProxyOrigin(4242);
        assertEquals("http://127.0.0.1:4242", origin.origin());
        assertTrue(origin.sameOrigin("http://127.0.0.1:4242/manager?x=1"));
        assertFalse(origin.sameOrigin("http://127.0.0.1:4243/"));
        assertFalse(origin.sameOrigin("https://127.0.0.1:4242/"));
        assertFalse(origin.sameOrigin("http://127.0.0.1/"));
        assertFalse(origin.sameOrigin("http://127.0.0.1.evil.com:4242/"));
        assertFalse(origin.sameOrigin("http://127.0.0.1:4242@evil.com/"));
        assertTrue(RequestGate.blocks(origin, "http://127.0.0.1:9999/x"));
        assertTrue(RequestGate.blocks(origin, "http://localhost:4242/x"));
        assertFalse(RequestGate.blocks(origin, "http://127.0.0.1:4242/x"));
    }

    @Test
    public void aRelayPageNeverFollowsAnSsoRedirectInApp() {
        ProxyOrigin origin = new ProxyOrigin(4242);
        String page = origin.url("/manager");
        assertEquals(NavigationPolicy.Action.EXTERNAL, NavigationPolicy.decide(origin, "https://sso.example.com/", page, true, true));
        assertEquals(NavigationPolicy.Action.ALLOW, NavigationPolicy.decide(origin, origin.url("/x"), page, true, false));
        assertEquals(NavigationPolicy.Action.SERVERS, NavigationPolicy.decide(origin, "cezar://servers", page, true, false));
        assertEquals(NavigationPolicy.Action.EXTERNAL, NavigationPolicy.decideWindow(origin, "http://127.0.0.1:9999/"));
    }

    private static RelayStatus status(RelayStatus.Kind kind) {
        return new RelayStatus(kind, 0);
    }

    @Test
    public void bannerTable() {
        assertNull("a quick reconnect shows nothing", ConnectionBanner.of(status(RelayStatus.Kind.RELAY_DOWN), 4999));
        String relay = ConnectionBanner.of(status(RelayStatus.Kind.RELAY_DOWN), 5000).text;
        assertEquals("Can't reach the Cezar relay. Your computer is fine. Retrying…", relay);
        assertEquals("Your computer is asleep or cezar isn't running.", ConnectionBanner.of(status(RelayStatus.Kind.CEZAR_OFFLINE), 5000).text);
        assertEquals("Too much traffic today. Back in 10 minutes.", ConnectionBanner.of(new RelayStatus(RelayStatus.Kind.QUOTA, 541), 5000).text);
        assertEquals("Update the app.", ConnectionBanner.of(status(RelayStatus.Kind.UPDATE_APP), 0).text);
        assertEquals("Update cezar on your computer.", ConnectionBanner.of(status(RelayStatus.Kind.UPDATE_CEZAR), 0).text);
        assertNull(ConnectionBanner.of(status(RelayStatus.Kind.READY), 100000));
        assertNull(ConnectionBanner.of(status(RelayStatus.Kind.DEVICE_REMOVED), 100000));
        assertFalse(ConnectionBanner.of(new RelayStatus(RelayStatus.Kind.QUOTA, 60), 5000).retry);
        assertNotNull(ConnectionBanner.of(status(RelayStatus.Kind.BROKEN), 0));
    }

    /** Remote cleartext stays refused: one exception in main, and it is loopback. */
    @Test
    public void releaseNetworkConfigHasOneLoopbackException() throws IOException {
        String xml = new String(Files.readAllBytes(new File("src/main/res/xml/network_security_config.xml").toPath()), StandardCharsets.UTF_8);
        assertEquals(2, xml.split("<domain ").length);
        assertTrue(xml, xml.contains(">127.0.0.1</domain>"));
        assertTrue(xml, xml.contains("<base-config cleartextTrafficPermitted=\"false\""));
        String manifest = new String(Files.readAllBytes(new File("src/main/AndroidManifest.xml").toPath()), StandardCharsets.UTF_8);
        assertFalse("the debug QR intent is not in main", manifest.contains("DebugPairActivity"));
    }
}
