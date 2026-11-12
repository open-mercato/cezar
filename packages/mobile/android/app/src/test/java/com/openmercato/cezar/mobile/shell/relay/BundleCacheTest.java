package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class BundleCacheTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static List<TunnelFrame.Header> headers(String... pairs) {
        TunnelFrame.Header[] out = new TunnelFrame.Header[pairs.length / 2];
        for (int i = 0; i < pairs.length; i += 2) out[i / 2] = new TunnelFrame.Header(pairs[i], pairs[i + 1]);
        return Arrays.asList(out);
    }

    private static final List<TunnelFrame.Header> ASSET = headers("content-type", "text/javascript", "cache-control", "public, max-age=31536000, immutable");
    private static final List<TunnelFrame.Header> SHELL = headers("content-type", "text/html; charset=utf-8", "cache-control", "no-cache", "etag", "\"1\"");

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void onlyHashedBundleFilesAndPageLoadsAreCandidates() {
        assertEquals(BundleCache.Kind.ASSET, BundleCache.kindOf("GET", "/assets/index-Ab12.js", "script", "*/*"));
        assertEquals(BundleCache.Kind.SHELL, BundleCache.kindOf("GET", "/manager/abc?x=1", "document", "text/html"));
        assertEquals(BundleCache.Kind.SHELL, BundleCache.kindOf("GET", "/", null, "text/html,application/xhtml+xml"));
        assertEquals(BundleCache.Kind.NONE, BundleCache.kindOf("GET", "/api/v1/workspace/managers", "empty", "*/*"));
        assertEquals("an API page load is still the API", BundleCache.Kind.NONE, BundleCache.kindOf("GET", "/api/v1/health", "document", "text/html"));
        assertEquals(BundleCache.Kind.NONE, BundleCache.kindOf("POST", "/assets/x.js", "script", "*/*"));
        assertEquals(BundleCache.Kind.NONE, BundleCache.kindOf("GET", "/assets/../secret", "script", "*/*"));
        assertEquals(BundleCache.Kind.NONE, BundleCache.kindOf("GET", "/assets/sub/x.js", "script", "*/*"));
        assertEquals(BundleCache.Kind.NONE, BundleCache.kindOf("GET", "/icon.svg", "image", "image/*"));
    }

    @Test
    public void onlyWhatTheServerMarksStaticIsKept() {
        assertTrue(BundleCache.storable(BundleCache.Kind.ASSET, 200, ASSET));
        assertFalse("an asset not marked immutable", BundleCache.storable(BundleCache.Kind.ASSET, 200, headers("content-type", "text/javascript")));
        assertTrue(BundleCache.storable(BundleCache.Kind.SHELL, 200, SHELL));
        assertTrue("cezar's shell carries no ETag", BundleCache.storable(BundleCache.Kind.SHELL, 200, headers("content-type", "text/html")));
        assertFalse("a login page is no shell", BundleCache.storable(BundleCache.Kind.SHELL, 200, headers("content-type", "application/json", "etag", "x")));
        assertFalse(BundleCache.storable(BundleCache.Kind.ASSET, 404, ASSET));
        assertFalse(BundleCache.storable(BundleCache.Kind.SHELL, 200, headers("content-type", "text/html", "etag", "x", "cache-control", "no-store")));
        assertFalse(BundleCache.storable(BundleCache.Kind.NONE, 200, ASSET));
    }

    @Test
    public void entriesRoundTripWithTheirHeadersAndNothingElse() {
        BundleCache cache = new BundleCache(new File(folder.getRoot(), "s1"), 1 << 20);
        cache.put(BundleCache.Kind.ASSET, "/assets/a-1.js?v=2", headers("content-type", "text/javascript", "cache-control", "immutable", "set-cookie", "s=1"), bytes("a()"));
        BundleCache.Entry hit = cache.get(BundleCache.Kind.ASSET, "/assets/a-1.js");
        assertEquals("a()", new String(hit.body, StandardCharsets.UTF_8));
        assertEquals("text/javascript", hit.header("content-type"));
        assertNull("never a cookie", hit.header("set-cookie"));
        cache.put(BundleCache.Kind.SHELL, "/", SHELL, bytes("<html>"));
        assertEquals("one shell answers every route", "<html>", new String(cache.get(BundleCache.Kind.SHELL, "/tasks/1").body, StandardCharsets.UTF_8));
        assertTrue(cache.hasShell());
    }

    @Test
    public void theStartPathIsRememberedAndClearGoesWithEverything() {
        File dir = new File(folder.getRoot(), "s2");
        BundleCache cache = new BundleCache(dir, 1 << 20);
        cache.saveStartPath("/manager");
        cache.put(BundleCache.Kind.SHELL, "/", SHELL, bytes("<html>"));
        assertEquals("/manager", new BundleCache(dir, 1 << 20).startPath());
        cache.clear();
        assertFalse(dir.exists());
        assertFalse(cache.hasShell());
        assertNull(cache.startPath());
    }

    @Test
    public void overTheCapTheOldestBundleFilesGoButTheShellStays() throws Exception {
        BundleCache cache = new BundleCache(new File(folder.getRoot(), "s3"), 2500);
        cache.put(BundleCache.Kind.SHELL, "/", SHELL, new byte[500]);
        cache.put(BundleCache.Kind.ASSET, "/assets/old.js", ASSET, new byte[1000]);
        new File(folder.getRoot(), "s3").listFiles((dir, name) -> name.startsWith("a-"))[0].setLastModified(1000);
        cache.put(BundleCache.Kind.ASSET, "/assets/new.js", ASSET, new byte[1000]);
        assertNull(cache.get(BundleCache.Kind.ASSET, "/assets/old.js"));
        assertEquals(1000, cache.get(BundleCache.Kind.ASSET, "/assets/new.js").body.length);
        assertTrue(cache.hasShell());
    }

    @Test
    public void aDamagedFileIsAMissNotACrash() throws Exception {
        File dir = new File(folder.getRoot(), "s4");
        BundleCache cache = new BundleCache(dir, 1 << 20);
        cache.put(BundleCache.Kind.SHELL, "/", SHELL, bytes("<html>"));
        try (FileOutputStream out = new FileOutputStream(new File(dir, "shell"))) {
            out.write(new byte[] {0, 0, 0, 1, 0x7f, 0x7f});
        }
        assertNull(cache.get(BundleCache.Kind.SHELL, "/"));
        assertFalse(cache.hasShell());
    }
}
