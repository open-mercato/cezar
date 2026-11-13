package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class StartupLogTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private long now = 1_700_000_000_000L;

    @Test
    public void stepsCarryTheirOffsetAndOutliveTheProcess() {
        File file = new File(folder.getRoot(), "startup.log");
        StartupLog log = new StartupLog(file, () -> now);
        log.begin("open relay rome.cezar.run");
        now += 812;
        log.step("relay READY");
        String text = new StartupLog(file, () -> now).text();
        assertTrue(text, text.startsWith("── 2023-11-14T22:13:20Z open relay rome.cezar.run\n"));
        assertTrue(text, text.contains("+812ms relay READY\n"));
    }

    @Test
    public void keepsOnlyTheNewestLines() {
        StartupLog log = new StartupLog(new File(folder.getRoot(), "l"), () -> now);
        log.begin("open");
        for (int i = 0; i < StartupLog.MAX_LINES + 50; i++) log.step("s" + i);
        String[] lines = log.text().split("\n");
        assertEquals(StartupLog.MAX_LINES, lines.length);
        assertTrue(lines[lines.length - 1].endsWith("s" + (StartupLog.MAX_LINES + 49)));
    }

    @Test
    public void anUnwritableLogStillAnswers() {
        StartupLog log = new StartupLog(new File(folder.getRoot(), "missing/dir/startup.log"), () -> now);
        log.begin("open");
        assertTrue(log.text().contains("open"));
    }
}
