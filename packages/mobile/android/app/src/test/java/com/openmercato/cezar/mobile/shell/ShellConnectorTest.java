package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ShellConnectorTest {
    private static final HttpAnswer CEZAR = HealthClassifierTest.answer(200, "application/json", null, "{\"version\":\"1\",\"capabilities\":{\"managers\":true}}");
    private static final HttpAnswer NO_MANAGER = HealthClassifierTest.answer(200, "application/json", null, "{\"version\":\"0.9\",\"capabilities\":{}}");
    private static final HttpAnswer GATE = HealthClassifierTest.answer(401, "text/html", "Basic realm=\"cezar\"", "<html>");
    private static final HttpAnswer LOCAL = HealthClassifierTest.answer(403, "application/json", null, "{\"error\":\"unexpected Host header\"}");
    private static final HttpAnswer LOGIN = HealthClassifierTest.answer(302, null, null, "");

    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final Deque<HttpAnswer> answers = new ArrayDeque<>();
    private final List<Map<String, String>> sent = new ArrayList<>();
    private ServerListStore servers;
    private CredentialStore credentials;
    private ShellConnector connector;

    @Before
    public void build() {
        servers = new ServerListStore(folder.getRoot());
        credentials = new CredentialStore(folder.getRoot(), new CredentialStore.Cipher() {
            @Override public byte[] seal(byte[] plain) {
                return plain;
            }

            @Override public byte[] open(byte[] sealed) {
                return sealed;
            }
        });
        HttpGet http = (url, headers) -> {
            sent.add(headers);
            if (answers.isEmpty()) throw new IOException("offline");
            return answers.poll();
        };
        connector = new ShellConnector(servers, credentials, new HealthProbe(http, "ua"));
    }

    private void script(HttpAnswer... next) {
        answers.clear();
        for (HttpAnswer answer : next) answers.add(answer);
    }

    private ShellConnector.Outcome addGated() {
        script(GATE, CEZAR);
        return connector.add("https://cezar.example.com", "me", "secret", null);
    }

    @Test
    public void noGateSavesAndOpensManager() {
        script(CEZAR);
        ShellConnector.Outcome outcome = connector.add("https://cezar.example.com", null, null, "Box");
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertEquals("https://cezar.example.com/manager", outcome.url);
        assertEquals("Box", servers.get(outcome.serverId).label);
        assertEquals(outcome.serverId, servers.lastUsedId());
    }

    @Test
    public void aGateAsksForCredentialsAndSavesNothing() {
        script(GATE);
        ShellConnector.Outcome outcome = connector.add("https://cezar.example.com", null, null, null);
        assertEquals(ShellConnector.ASK_CREDENTIALS, outcome.screen);
        assertTrue(servers.list().isEmpty());
    }

    @Test
    public void credentialsSaveTheRealmAndKeepThePasswordOutOfTheList() {
        ShellConnector.Outcome outcome = addGated();
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertEquals("cezar", servers.get(outcome.serverId).realm);
        assertEquals("secret", credentials.get(outcome.serverId));
        assertNull(sent.get(0).get("Authorization"));
        assertNotNull(sent.get(1).get("Authorization"));
    }

    @Test
    public void aWrongPasswordIsRejectedAndNotSaved() {
        script(GATE, GATE);
        ShellConnector.Outcome outcome = connector.add("https://cezar.example.com", "me", "wrong", null);
        assertEquals(ShellConnector.PASSWORD_REJECTED, outcome.screen);
        assertTrue(servers.list().isEmpty());
    }

    @Test
    public void aRetriedAnswerGoesBackThroughTheTable() {
        script(GATE, LOCAL);
        ShellConnector.Outcome outcome = connector.add("https://cezar.example.com", "me", "secret", null);
        assertEquals(ShellConnector.LOCAL_MODE, outcome.screen);
        assertTrue(servers.list().isEmpty());
    }

    @Test
    public void cleartextIsRefusedBeforeAnyRequest() {
        assertEquals(ShellConnector.CLEARTEXT, connector.add("http://cezar.example.com", null, null, null).screen);
        assertTrue(sent.isEmpty());
    }

    @Test
    public void aLoginPageOpensUnsavedUntilHealthReadsAsCezar() {
        script(LOGIN);
        ShellConnector.Outcome outcome = connector.add("https://cezar.example.com", null, null, null);
        assertEquals(ShellConnector.LOGIN, outcome.screen);
        assertEquals("https://cezar.example.com/", outcome.url);
        assertTrue(servers.list().isEmpty());

        script(LOGIN);
        assertEquals(ShellConnector.LOGIN, connector.confirmLogin("https://cezar.example.com/", null, null).screen);
        assertTrue(servers.list().isEmpty());

        script(CEZAR);
        ShellConnector.Outcome saved = connector.confirmLogin("https://cezar.example.com/", "sso=1", null);
        assertEquals(ShellConnector.OPEN, saved.screen);
        assertEquals("sso=1", sent.get(sent.size() - 1).get("Cookie"));
        assertEquals(1, servers.list().size());
    }

    @Test
    public void aChangedRealmAsksAgainAndTheNewAnswerSavesIt() {
        String id = addGated().serverId;
        HttpAnswer moved = HealthClassifierTest.answer(401, "text/html", "Basic realm=\"moved\"", "<html>");
        script(CEZAR, moved);
        assertEquals(ShellConnector.ASK_CREDENTIALS, connector.open(id, null).screen);

        script(moved, CEZAR);
        assertEquals(ShellConnector.OPEN, connector.add("https://cezar.example.com", "me", "secret", null).screen);
        assertEquals("moved", servers.get(id).realm);
    }

    @Test
    public void anUnchangedRealmOpens() {
        String id = addGated().serverId;
        script(CEZAR, GATE);
        assertEquals(ShellConnector.OPEN, connector.open(id, null).screen);
    }

    @Test
    public void addingTheSameOriginAgainReplacesIt() {
        String id = addGated().serverId;
        assertEquals(id, addGated().serverId);
        assertEquals(1, servers.list().size());
    }

    @Test
    public void launchWithNothingSavedShowsTheList() {
        assertEquals(ShellConnector.LIST, connector.launch(null).screen);
        assertTrue(sent.isEmpty());
    }

    @Test
    public void launchOpensTheLastUsedWithTheSavedPassword() {
        addGated();
        script(CEZAR, GATE);
        ShellConnector.Outcome outcome = connector.launch(null);
        assertEquals(ShellConnector.OPEN, outcome.screen);
        assertNotNull(sent.get(sent.size() - 2).get("Authorization"));
        assertNull("the realm check sends no password", sent.get(sent.size() - 1).get("Authorization"));
    }

    @Test
    public void aRotatedPasswordIsRejectedOnOpen() {
        String id = addGated().serverId;
        script(GATE);
        assertEquals(ShellConnector.PASSWORD_REJECTED, connector.open(id, null).screen);
    }

    @Test
    public void anUnreachableServerIsTheErrorScreen() {
        String id = addGated().serverId;
        script();
        assertEquals(ShellConnector.CONNECTION_ERROR, connector.open(id, null).screen);
    }

    @Test
    public void anOldServerOpensRootWithANoteOnce() {
        script(NO_MANAGER);
        ShellConnector.Outcome first = connector.add("https://cezar.example.com", null, null, null);
        assertEquals("https://cezar.example.com/", first.url);
        assertTrue(first.note.contains("0.9"));
        assertTrue(first.note.contains("server-deploy"));
        script(NO_MANAGER);
        assertNull(connector.open(first.serverId, null).note);
    }

    @Test
    public void forgetDeletesThePasswordAndTheRow() {
        String id = addGated().serverId;
        connector.forget(id);
        assertNull(credentials.get(id));
        assertNull(servers.get(id));
        assertNull(servers.lastUsedId());
    }

    @Test
    public void aCorruptListReadsAsEmpty() throws Exception {
        java.nio.file.Files.write(new java.io.File(folder.getRoot(), "servers.json").toPath(), new byte[] {'{'});
        assertTrue(servers.list().isEmpty());
        assertEquals(ShellConnector.LIST, connector.launch(null).screen);
    }
}
