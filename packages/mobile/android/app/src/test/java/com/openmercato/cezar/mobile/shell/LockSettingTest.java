package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Test;

public class LockSettingTest {
    @Test
    public void offByDefaultAndSurvivesARestart() throws IOException {
        File directory = Files.createTempDirectory("lock").toFile();
        assertFalse(new LockSetting(directory).enabled());
        new LockSetting(directory).set(true);
        assertTrue(new LockSetting(directory).enabled());
        new LockSetting(directory).set(false);
        assertFalse(new LockSetting(directory).enabled());
    }

    @Test
    public void holdsNoBytes() throws IOException {
        File directory = Files.createTempDirectory("lock").toFile();
        new LockSetting(directory).set(true);
        assertEquals(0, directory.listFiles()[0].length());
    }

    @Test(expected = IOException.class)
    public void aFailedWriteIsReported() throws IOException {
        File notADirectory = Files.createTempFile("lock", "file").toFile();
        new LockSetting(notADirectory).set(true);
    }
}
