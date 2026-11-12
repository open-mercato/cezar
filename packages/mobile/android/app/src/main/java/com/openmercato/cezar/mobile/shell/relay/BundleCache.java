package com.openmercato.cezar.mobile.shell.relay;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * The cockpit's static bundle for one relay server, so a cold start paints without the tunnel. Only the
 * shell (one per server, checked against the server's on every start) and Vite's hashed, immutable `/assets/*`: never an API
 * answer. App-private files under no-backup storage; Forget and Remove delete the directory.
 */
public final class BundleCache {
    public enum Kind { NONE, SHELL, ASSET }

    /** A cached answer: status 200 always, with the headers it came with. */
    public static final class Entry {
        public final List<TunnelFrame.Header> headers;
        public final byte[] body;

        Entry(List<TunnelFrame.Header> headers, byte[] body) {
            this.headers = headers;
            this.body = body;
        }

        public String header(String name) {
            for (TunnelFrame.Header header : headers) if (header.name.equals(name)) return header.value;
            return null;
        }
    }

    private static final int FORMAT = 1;
    private static final String SHELL = "shell";
    private static final String PATH = "path";
    /** A shell or bundle file past this is not the cockpit: it goes through uncached. */
    public static final int MAX_ENTRY_BYTES = 8 * 1024 * 1024;
    private static final List<String> KEPT = Arrays.asList("content-type", "cache-control", "etag", "last-modified",
            "content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy");

    private final File dir;
    private final long maxBytes;

    public BundleCache(File dir, long maxBytes) {
        this.dir = dir;
        this.maxBytes = maxBytes;
    }

    /** `/assets/<file>` by its path; any other page load is the SPA shell the server answers every route with. */
    public static Kind kindOf(String method, String target, String fetchDest, String accept) {
        if (!"GET".equals(method)) return Kind.NONE;
        String path = target.split("[?#]", 2)[0];
        if (path.startsWith("/assets/") && path.indexOf('/', 8) < 0 && !path.contains("..") && path.length() > 8) return Kind.ASSET;
        if (path.equals("/api") || path.startsWith("/api/") || path.startsWith("/assets/")) return Kind.NONE;
        boolean document = fetchDest != null ? fetchDest.equals("document") : accept != null && accept.contains("text/html");
        return document ? Kind.SHELL : Kind.NONE;
    }

    /** Whether this answer may be kept: a whole 200 that the server itself marks as static. */
    public static boolean storable(Kind kind, int status, List<TunnelFrame.Header> headers) {
        if (kind == Kind.NONE || status != 200) return false;
        String type = value(headers, "content-type");
        String cache = value(headers, "cache-control");
        if (cache != null && cache.toLowerCase(Locale.ROOT).contains("no-store")) return false;
        if (kind == Kind.ASSET) return cache != null && cache.toLowerCase(Locale.ROOT).contains("immutable");
        return type != null && type.toLowerCase(Locale.ROOT).startsWith("text/html");
    }

    public synchronized Entry get(Kind kind, String target) {
        File file = file(kind, target);
        if (file == null || !file.isFile()) return null;
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            if (in.readInt() != FORMAT) return null;
            int count = in.readInt();
            if (count < 0 || count > 64) return null;
            List<TunnelFrame.Header> headers = new ArrayList<>();
            for (int i = 0; i < count; i++) headers.add(new TunnelFrame.Header(in.readUTF(), in.readUTF()));
            int length = in.readInt();
            if (length < 0 || length > MAX_ENTRY_BYTES) return null;
            byte[] body = new byte[length];
            in.readFully(body);
            file.setLastModified(System.currentTimeMillis());
            return new Entry(Collections.unmodifiableList(headers), body);
        } catch (IOException e) {
            file.delete();
            return null;
        }
    }

    public synchronized void put(Kind kind, String target, List<TunnelFrame.Header> headers, byte[] body) {
        File file = file(kind, target);
        if (file == null || body.length > MAX_ENTRY_BYTES || (!dir.isDirectory() && !dir.mkdirs())) return;
        List<TunnelFrame.Header> kept = new ArrayList<>();
        for (TunnelFrame.Header header : headers) if (KEPT.contains(header.name)) kept.add(header);
        File temp = new File(dir, file.getName() + ".tmp");
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream(temp))) {
            out.writeInt(FORMAT);
            out.writeInt(kept.size());
            for (TunnelFrame.Header header : kept) {
                out.writeUTF(header.name);
                out.writeUTF(header.value);
            }
            out.writeInt(body.length);
            out.write(body);
        } catch (IOException e) {
            temp.delete();
            return;
        }
        if (!temp.renameTo(file)) temp.delete();
        trim();
    }

    /** The start path the last probed open chose (`/manager` or `/`), so the next one can skip the probe. */
    public synchronized String startPath() {
        Entry entry = get(Kind.NONE, PATH);
        return entry == null ? null : new String(entry.body, StandardCharsets.UTF_8);
    }

    public synchronized void saveStartPath(String path) {
        put(Kind.NONE, PATH, Collections.<TunnelFrame.Header>emptyList(), path.getBytes(StandardCharsets.UTF_8));
    }

    /** A shell to paint from: what lets a start skip the probe. */
    public synchronized boolean hasShell() {
        File shell = file(Kind.SHELL, "/");
        return shell != null && shell.isFile();
    }

    public synchronized void clear() {
        File[] files = dir.listFiles();
        if (files != null) for (File file : files) file.delete();
        dir.delete();
    }

    /** Oldest bundle files go first; the shell and the start path stay. */
    private void trim() {
        File[] files = dir.listFiles();
        if (files == null) return;
        long total = 0;
        List<File> assets = new ArrayList<>();
        for (File file : files) {
            total += file.length();
            if (file.getName().startsWith("a-")) assets.add(file);
        }
        if (total <= maxBytes) return;
        Collections.sort(assets, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File file : assets) {
            if (total <= maxBytes) break;
            total -= file.length();
            file.delete();
        }
    }

    private File file(Kind kind, String target) {
        switch (kind) {
            case SHELL:
                return new File(dir, SHELL);
            case ASSET:
                return new File(dir, "a-" + sha256(target.split("[?#]", 2)[0]));
            default:
                return PATH.equals(target) ? new File(dir, PATH) : null;
        }
    }

    private static String value(List<TunnelFrame.Header> headers, String name) {
        for (TunnelFrame.Header header : headers) if (header.name.equals(name)) return header.value;
        return null;
    }

    private static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 16; i++) out.append(String.format(Locale.ROOT, "%02x", digest[i]));
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Collects a body as it streams by, giving up past the entry cap. */
    public static final class Capture {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private boolean overflow;

        public void add(byte[] data) {
            if (overflow) return;
            if (bytes.size() + data.length > MAX_ENTRY_BYTES) {
                overflow = true;
                return;
            }
            bytes.write(data, 0, data.length);
        }

        public byte[] bytes() {
            return overflow ? null : bytes.toByteArray();
        }
    }
}
