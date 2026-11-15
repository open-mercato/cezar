package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ServerListStoreTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private static ServerRecord server(String id) {
        return new ServerRecord(id, id, "https://" + id + ".example.test", null, null, null);
    }

    /** Every save replaces the last one, the case File.renameTo must cover now that ATOMIC_MOVE is gone. */
    @Test
    public void aSecondSaveReplacesTheFileAndLeavesNoTemporary() throws Exception {
        File directory = folder.getRoot();
        ServerListStore store = new ServerListStore(directory);
        store.put(server("a"));
        store.put(server("b"));
        assertEquals(2, new ServerListStore(directory).list().size());
        assertFalse(new File(directory, "servers.json.tmp").exists());
    }

    @Test
    public void anUnreadableListReadsAsEmpty() {
        assertTrue(new ServerListStore(new File(folder.getRoot(), "missing")).list().isEmpty());
    }

    @Test
    public void lastSeenAndCountsSurviveSavesAndSumIntoTheBadge() {
        ServerListStore store = new ServerListStore(folder.getRoot());
        store.put(server("a"));
        store.put(server("b"));
        assertEquals(0, store.seen("a").at);
        assertNull(store.seen("a").need());
        store.markSeen("a", 1000);
        store.setCounts("a", 2, 1);
        store.setWaiting("b", 4);
        store.put(server("c"));
        store.markUsed("a");
        ServerListStore reread = new ServerListStore(folder.getRoot());
        assertEquals(1000, reread.seen("a").at);
        assertEquals(Integer.valueOf(3), reread.seen("a").need());
        assertEquals(Integer.valueOf(4), reread.seen("b").need());
        assertEquals(7, reread.totalNeed());
    }

    @Test
    public void unknownCountsAddNothingAndAForgottenServerTakesItsOwnAlong() {
        ServerListStore store = new ServerListStore(folder.getRoot());
        store.put(server("a"));
        store.put(server("b"));
        store.setCounts("a", 2, 0);
        store.setCounts("b", 5, 0);
        store.setCounts("b", null, null);
        assertEquals(2, store.totalNeed());
        store.remove("a");
        assertEquals(0, store.totalNeed());
        store.put(server("a"));
        assertNull(store.seen("a").need());
        // A count for a server that is not saved is dropped.
        store.setWaiting("ghost", 9);
        assertEquals(0, store.totalNeed());
    }

    @Test
    public void anOlderSightingNeverMovesLastSeenBack() {
        ServerListStore store = new ServerListStore(folder.getRoot());
        store.put(server("a"));
        store.markSeen("a", 2000);
        store.markSeen("a", 1000);
        assertEquals(2000, store.seen("a").at);
    }

    @Test(expected = IllegalStateException.class)
    public void aFailedSaveThrows() {
        new ServerListStore(new File(folder.getRoot(), "missing")).put(server("a"));
    }
}
