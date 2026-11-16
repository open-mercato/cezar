package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/**
 * The activity has no JVM harness, so this pins its source order: rc.4 read `startLog` inside
 * openProxy before onCreate set it, and `log::step` on null killed every relay open.
 */
public class ServerActivityStartTest {
    private static String onCreate() throws Exception {
        File file = new File("src/main/java/com/openmercato/cezar/mobile/shell/ServerActivity.java");
        String source = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        int start = source.indexOf("protected void onCreate(");
        int end = source.indexOf("\n    }\n", start);
        assertTrue("onCreate not found", start >= 0 && end > start);
        return source.substring(start, end);
    }

    @Test
    public void theStartupLogIsReadyBeforeTheRelayOpens() throws Exception {
        String body = onCreate();
        int created = body.indexOf("startLog = ShellServices.startupLog(this)");
        int begun = body.indexOf("startLog.begin(");
        int relay = body.indexOf("openProxy(");
        assertTrue("startLog is created in onCreate", created >= 0);
        assertTrue("openProxy is called from onCreate", relay >= 0);
        assertTrue("startLog is created before openProxy", created < relay);
        assertTrue("startLog begins before openProxy", begun > created && begun < relay);
    }
}
