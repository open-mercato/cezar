package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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

    @Test(expected = IllegalStateException.class)
    public void aFailedSaveThrows() {
        new ServerListStore(new File(folder.getRoot(), "missing")).put(server("a"));
    }
}
