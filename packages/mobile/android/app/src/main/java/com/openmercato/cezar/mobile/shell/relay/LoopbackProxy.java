package com.openmercato.cezar.mobile.shell.relay;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The plain-HTTP face of the tunnel under the webview (spec "The proxy's rules", RELAY_PROTOCOL.md § 13).
 * Binds 127.0.0.1 only. Other apps on the phone can reach the port, so every request passes the gate
 * first, and nothing that fails it enters the tunnel.
 */
public final class LoopbackProxy implements Closeable {
    public interface Tunnel {
        /** The live session, or null. */
        TunnelSession session();
    }

    public static final String COOKIE = "cezar_gate";
    private static final int MAX_CONNECTIONS = 64;
    private static final long ACCEPT_BACKOFF_MS = 250;
    private static final int HEAD_TIMEOUT_MS = 30000;
    private static final int KEEP_ALIVE_MS = 60000;
    private static final int READ_CHUNK = 65536;
    /** A request that arrives while the session is still coming up waits for it, rather than failing at once. */
    private static final long SESSION_WAIT_MS = 10000;
    private static final long REVALIDATE_WAIT_MS = 30000;
    private static final long REVALIDATE_TIMEOUT_MS = 15000;
    private static final java.util.regex.Pattern ASSET_NAME = java.util.regex.Pattern.compile("/assets/[A-Za-z0-9._-]+");
    private static final int MAX_PREFETCH = 40;
    /** Added beside the server's own policy, which still applies: the cookie must not reach another loopback port. */
    private static final String CONTENT_SECURITY_POLICY = "content-security-policy: connect-src 'self'\r\n";
    private static final Set<String> DROPPED_REQUEST = new HashSet<>(Arrays.asList(
            "host", "origin", "cookie", "authorization", "x-cezar-runtime-handoff", "forwarded", "x-real-ip", "user-agent", "expect",
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"));
    private static final Set<String> DROPPED_RESPONSE = new HashSet<>(Arrays.asList(
            "set-cookie", "www-authenticate",
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"));

    private final Tunnel tunnel;
    private final String userAgent;
    /** Null: everything goes through the tunnel, as before the cache. */
    private final BundleCache cache;
    private volatile Runnable onShellChanged;
    private volatile boolean revalidating;
    private volatile long sessionWaitMs = SESSION_WAIT_MS;
    private final String cookie = hex(RelayCrypto.random(32));
    private final ExecutorService workers = Executors.newCachedThreadPool(run -> {
        Thread thread = new Thread(run, "cezar-proxy");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<Socket> connections = ConcurrentHashMap.newKeySet();
    /** Oldest first. Any app can open these, so they give way before the webview does. */
    private final ConcurrentLinkedQueue<Socket> ungated = new ConcurrentLinkedQueue<>();
    private ServerSocket listener;
    private String authority;
    private String allowedOrigin;
    private boolean rebound;
    private volatile boolean serving = true;
    private volatile boolean closed;

    public LoopbackProxy(Tunnel tunnel, String userAgent) {
        this(tunnel, userAgent, null);
    }

    public LoopbackProxy(Tunnel tunnel, String userAgent, BundleCache cache) {
        this.tunnel = tunnel;
        this.userAgent = userAgent;
        this.cache = cache;
    }

    /** Tests: how long a request waits for the session to come up. */
    void setSessionWait(long ms) {
        sessionWaitMs = ms;
    }

    /** Told once when the shell served from the cache turned out stale: the page should load again. */
    public void setOnShellChanged(Runnable listener) {
        onShellChanged = listener;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    /**
     * Binds the saved port, else a new one. {@link #rebound()} then says the old port was taken, which
     * spec "A taken port is hostile" treats as a page to tear down, never a port to wait for.
     */
    public int open(int preferredPort) throws IOException {
        InetAddress loopback = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        try {
            listener = new ServerSocket(preferredPort, 50, loopback);
        } catch (IOException e) {
            if (preferredPort == 0) throw e;
            rebound = true;
            listener = new ServerSocket(0, 50, loopback);
        }
        int port = listener.getLocalPort();
        authority = "127.0.0.1:" + port;
        allowedOrigin = "http://" + authority;
        Thread accept = new Thread(this::acceptLoop, "cezar-proxy-accept");
        accept.setDaemon(true);
        accept.start();
        return port;
    }

    public boolean rebound() {
        return rebound;
    }

    public int port() {
        return listener.getLocalPort();
    }

    /** A new random value per listener, set by native code in the webview store. Never in a URL. */
    public String cookieValue() {
        return cookie;
    }

    /** Off in the background: the port stays bound so nobody can take it, and live streams die (spec). */
    public void setServing(boolean value) {
        serving = value;
        if (!value) closeConnections();
    }

    private void closeConnections() {
        for (Socket socket : connections) closeQuietly(socket);
    }

    @Override
    public void close() {
        closed = true;
        closeQuietly(listener);
        closeConnections();
        workers.shutdownNow();
    }

    private static void closeQuietly(Closeable closeable) {
        try {
            if (closeable != null) closeable.close();
        } catch (IOException e) {
            // Nothing to do with a socket that will not close.
        }
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = listener.accept();
                if (connections.size() >= MAX_CONNECTIONS && !evictUngated()) {
                    closeQuietly(socket);
                    continue;
                }
                connections.add(socket);
                ungated.add(socket);
                workers.execute(() -> {
                    try {
                        serve(socket);
                    } catch (IOException e) {
                        // The connection went away. The stream, if any, was cancelled on the way out.
                    } finally {
                        connections.remove(socket);
                        ungated.remove(socket);
                        closeQuietly(socket);
                    }
                });
            } catch (IOException e) {
                if (closed) return;
                // Out of file descriptors, say: accept fails at once, and this must not spin.
                try {
                    Thread.sleep(ACCEPT_BACKOFF_MS);
                } catch (InterruptedException interrupted) {
                    return;
                }
            }
        }
    }

    private boolean evictUngated() {
        Socket oldest = ungated.poll();
        if (oldest == null) return false;
        connections.remove(oldest);
        closeQuietly(oldest);
        return true;
    }

    private void serve(Socket socket) throws IOException {
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(HEAD_TIMEOUT_MS);
        InputStream in = new BufferedInputStream(socket.getInputStream());
        OutputStream out = new BufferedOutputStream(socket.getOutputStream());
        while (true) {
            ProxyRequest request;
            try {
                request = ProxyRequest.read(in);
            } catch (ProxyRequest.Refused refused) {
                plain(out, refused.status, null, true);
                return;
            } catch (SocketTimeoutException e) {
                return;
            }
            if (request == null) return;
            int refusal = gate(request);
            if (refusal != 0) {
                plain(out, refusal, null, true);
                return;
            }
            ungated.remove(socket);
            if (!serving) {
                plain(out, 503, "retry-after: 1\r\n", true);
                return;
            }
            boolean again = exchange(socket, in, out, request);
            String connection = request.header("connection");
            boolean clientCloses = connection != null && connection.toLowerCase(Locale.ROOT).contains("close");
            if (!again || !request.http11 || clientCloses) return;
            socket.setSoTimeout(KEEP_ALIVE_MS);
        }
    }

    /** The gate of § 13.1: a status to refuse with, or 0. */
    private int gate(ProxyRequest request) {
        List<String> hosts = request.all("host");
        if (hosts.size() != 1 || !authority.equals(hosts.get(0))) return 403;
        if (!hasCookie(request)) return 403;
        List<String> origins = request.all("origin");
        if (origins.size() > 1 || (origins.size() == 1 && !allowedOrigin.equals(origins.get(0)))) return 403;
        List<String> sites = request.all("sec-fetch-site");
        if (sites.size() > 1) return 403;
        if (sites.size() == 1 && !sites.get(0).equals("same-origin") && !sites.get(0).equals("none")) return 403;
        if (!request.all("upgrade").isEmpty()) return 400;
        if (!TunnelFrame.validMethod(request.method)) return 405;
        if (request.target.length() > TunnelFrame.MAX_TARGET_BYTES) return 431;
        if (!TunnelFrame.validTarget(request.target)) return 400;
        for (TunnelFrame.Header header : request.headers) if (header.name.length() > TunnelFrame.MAX_NAME_BYTES) return 431;
        return 0;
    }

    private boolean hasCookie(ProxyRequest request) {
        byte[] expected = Bytes.ascii(cookie);
        boolean found = false;
        for (String header : request.all("cookie")) {
            for (String pair : header.split(";")) {
                int equals = pair.indexOf('=');
                if (equals < 0 || !pair.substring(0, equals).trim().equals(COOKIE)) continue;
                found |= org.bouncycastle.util.Arrays.constantTimeAreEqual(expected, pair.substring(equals + 1).trim().getBytes(StandardCharsets.ISO_8859_1));
            }
        }
        return found;
    }

    /** `whole`: a bundle file the phone lacks is asked for in full, since a 304 for the webview's copy cannot be kept. */
    private List<TunnelFrame.Header> forwarded(ProxyRequest request, boolean whole) {
        List<TunnelFrame.Header> out = new ArrayList<>();
        for (TunnelFrame.Header header : request.headers) {
            String name = header.name;
            if (DROPPED_REQUEST.contains(name) || name.startsWith("x-forwarded-") || name.startsWith("sec-fetch-")) continue;
            if (whole && (name.equals("if-none-match") || name.equals("if-modified-since"))) continue;
            out.add(header);
        }
        out.add(new TunnelFrame.Header("user-agent", userAgent));
        return out;
    }

    /** One request through the tunnel. True when the connection can carry another. Never retried. */
    private boolean exchange(Socket socket, InputStream in, OutputStream out, ProxyRequest request) throws IOException {
        BundleCache.Kind kind = cache == null ? BundleCache.Kind.NONE
                : BundleCache.kindOf(request.method, request.target, request.header("sec-fetch-dest"), request.header("accept"));
        if (kind != BundleCache.Kind.NONE) {
            BundleCache.Entry hit = cache.get(kind, request.target);
            if (hit != null) {
                // The shell paints at once; a newer one is fetched behind it, once the session is up.
                if (kind == BundleCache.Kind.SHELL) revalidate(request.target, hit);
                return cached(out, request, hit);
            }
        }
        TunnelSession session = awaitSession(sessionWaitMs);
        if (session == null) {
            plain(out, 503, "retry-after: 1\r\n", true);
            return false;
        }
        TunnelStream stream;
        try {
            stream = session.open(request.method, request.target, forwarded(request, kind != BundleCache.Kind.NONE));
        } catch (TunnelSession.TooManyStreams e) {
            plain(out, 503, "retry-after: 1\r\n", true);
            return false;
        } catch (TunnelSession.HeadTooLarge e) {
            plain(out, 431, null, true);
            return false;
        } catch (IOException e) {
            plain(out, 503, "retry-after: 1\r\n", true);
            return false;
        }
        try {
            if ("100-continue".equalsIgnoreCase(request.header("expect"))) {
                out.write(Bytes.ascii("HTTP/1.1 100 Continue\r\n\r\n"));
                out.flush();
            }
            boolean bodySent = pumpBody(request, stream);
            return respond(socket, in, out, request, stream, kind) && bodySent;
        } finally {
            stream.cancel(TunnelFrame.RESET_CANCELLED);
        }
    }

    /** False when the stream went away mid-body. What is left is drained, then the answer is read. */
    private boolean pumpBody(ProxyRequest request, TunnelStream stream) throws IOException {
        byte[] buffer = new byte[READ_CHUNK];
        boolean flowing = true;
        while (true) {
            int count;
            try {
                count = request.readBody(buffer);
            } catch (IOException e) {
                // A body that does not match what its head said.
                stream.cancel(TunnelFrame.RESET_BAD_REQUEST);
                throw e;
            }
            if (count == -1) break;
            if (!flowing) continue;
            try {
                stream.write(buffer, 0, count);
            } catch (IOException e) {
                flowing = false;
            }
        }
        if (flowing) stream.finishRequest();
        return flowing;
    }

    private boolean respond(Socket socket, InputStream in, OutputStream out, ProxyRequest request, TunnelStream stream, BundleCache.Kind kind) throws IOException {
        boolean started = false;
        BundleCache.Capture capture = null;
        List<TunnelFrame.Header> capturedHeaders = null;
        boolean chunked = false;
        boolean bodiless = false;
        long remaining = -1;
        while (true) {
            TunnelStream.Event event;
            try {
                event = stream.next(1000);
            } catch (InterruptedException e) {
                throw new IOException(e);
            }
            if (event == null) {
                if (clientLeft(socket, in)) return false;
                continue;
            }
            switch (event.kind) {
                case HEAD:
                    started = true;
                    bodiless = request.method.equals("HEAD") || event.status == 204 || event.status == 304;
                    String length = headerOf(event.headers, "content-length");
                    if (length != null && length.matches("[0-9]{1,18}")) remaining = Long.parseLong(length);
                    chunked = !bodiless && remaining < 0;
                    writeHead(out, request, event, chunked);
                    if (bodiless) remaining = 0;
                    if (!bodiless && BundleCache.storable(kind, event.status, event.headers)) {
                        capture = new BundleCache.Capture();
                        capturedHeaders = event.headers;
                    }
                    out.flush();
                    break;
                case DATA:
                    // Past its content-length the rest would read as a second response on this kept-alive
                    // connection (security review F5): send what was promised, then close.
                    if (!bodiless && !chunked && remaining >= 0 && event.data.length > remaining) {
                        out.write(event.data, 0, (int) remaining);
                        out.flush();
                        return false;
                    }
                    if (!bodiless) {
                        if (chunked) out.write(Bytes.ascii(Integer.toHexString(event.data.length) + "\r\n"));
                        out.write(event.data);
                        if (chunked) out.write(Bytes.ascii("\r\n"));
                        if (remaining > 0) remaining -= event.data.length;
                        // Flushed per frame: this is what keeps SSE live (§ 12.2).
                        out.flush();
                    }
                    if (capture != null) capture.add(event.data);
                    stream.consumed(event.data.length);
                    break;
                case END:
                    if (chunked) out.write(Bytes.ascii("0\r\n\r\n"));
                    out.flush();
                    // A short body would otherwise read as complete.
                    boolean whole = bodiless || remaining <= 0;
                    byte[] body = capture == null ? null : capture.bytes();
                    if (whole && body != null) {
                        cache.put(kind, request.target, capturedHeaders, body);
                        if (kind == BundleCache.Kind.SHELL) prefetch(body);
                    }
                    return whole;
                default:
                    if (started) return false;
                    if (event.kind == TunnelStream.Kind.RESET && event.code == TunnelFrame.RESET_TOO_MANY_STREAMS) {
                        plain(out, 503, "retry-after: 1\r\n", true);
                    } else {
                        plain(out, 502, null, true);
                    }
                    return false;
            }
        }
    }

    /** The live session, waiting up to `ms` while it comes up. Null when it did not, or the page left. */
    private TunnelSession awaitSession(long ms) {
        long deadline = System.currentTimeMillis() + ms;
        while (true) {
            TunnelSession session = tunnel.session();
            if (session != null && session.live()) return session;
            if (closed || !serving || System.currentTimeMillis() >= deadline) return null;
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
    }

    /** A bundle file or shell from the phone, under the same added policy as a tunnelled one. */
    private boolean cached(OutputStream out, ProxyRequest request, BundleCache.Entry hit) throws IOException {
        StringBuilder text = new StringBuilder("HTTP/1.1 200 OK\r\n");
        for (TunnelFrame.Header header : hit.headers) text.append(header.name).append(": ").append(header.value).append("\r\n");
        text.append(CONTENT_SECURITY_POLICY);
        text.append("content-length: ").append(hit.body.length).append("\r\n\r\n");
        out.write(text.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (!request.method.equals("HEAD")) out.write(hit.body);
        out.flush();
        return true;
    }

    /** Once per listener: asks for the shell (with its ETag when it has one), keeps a newer one and says so. */
    private void revalidate(String target, BundleCache.Entry cached) {
        if (revalidating) return;
        revalidating = true;
        String etag = cached.header("etag");
        workers.execute(() -> {
            TunnelSession session = awaitSession(REVALIDATE_WAIT_MS);
            if (session == null) {
                revalidating = false;
                return;
            }
            List<TunnelFrame.Header> headers = new ArrayList<>();
            headers.add(new TunnelFrame.Header("accept", "text/html"));
            if (etag != null) headers.add(new TunnelFrame.Header("if-none-match", etag));
            headers.add(new TunnelFrame.Header("user-agent", userAgent));
            try {
                TunnelStream stream = session.open("GET", target, headers);
                try {
                    stream.finishRequest();
                    if (fetchShell(target, stream, cached)) {
                        Runnable listener = onShellChanged;
                        if (listener != null) listener.run();
                    }
                } finally {
                    stream.cancel(TunnelFrame.RESET_CANCELLED);
                }
            } catch (IOException | InterruptedException e) {
                // The cached shell stays; the next start asks again.
            }
        });
    }

    /**
     * The files the shell names (entry script, styles, preloads) are what the first paint needs. The
     * webview may hold them in its own cache and never ask, so they are fetched here once, behind the page.
     */
    private void prefetch(byte[] shell) {
        List<String> missing = new ArrayList<>();
        java.util.regex.Matcher names = ASSET_NAME.matcher(new String(shell, StandardCharsets.UTF_8));
        while (names.find() && missing.size() < MAX_PREFETCH) {
            String target = names.group();
            if (!missing.contains(target) && cache.get(BundleCache.Kind.ASSET, target) == null) missing.add(target);
        }
        if (missing.isEmpty()) return;
        workers.execute(() -> {
            for (String target : missing) {
                TunnelSession session = awaitSession(REVALIDATE_WAIT_MS);
                if (session == null || closed) return;
                List<TunnelFrame.Header> headers = new ArrayList<>();
                headers.add(new TunnelFrame.Header("user-agent", userAgent));
                try {
                    TunnelStream stream = session.open("GET", target, headers);
                    try {
                        stream.finishRequest();
                        fetchInto(BundleCache.Kind.ASSET, target, stream);
                    } finally {
                        stream.cancel(TunnelFrame.RESET_CANCELLED);
                    }
                } catch (IOException | InterruptedException e) {
                    return;
                }
            }
        });
    }

    /** Reads one whole answer into the cache when it may be kept. Returns its headers, or null. */
    private List<TunnelFrame.Header> fetchInto(BundleCache.Kind kind, String target, TunnelStream stream) throws IOException, InterruptedException {
        long deadline = System.currentTimeMillis() + REVALIDATE_TIMEOUT_MS;
        BundleCache.Capture body = new BundleCache.Capture();
        List<TunnelFrame.Header> headers = null;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            TunnelStream.Event event = left > 0 ? stream.next(left) : null;
            if (event == null) return null;
            switch (event.kind) {
                case HEAD:
                    if (!BundleCache.storable(kind, event.status, event.headers)) return null;
                    headers = event.headers;
                    break;
                case DATA:
                    body.add(event.data);
                    stream.consumed(event.data.length);
                    break;
                case END:
                    byte[] bytes = body.bytes();
                    if (bytes == null || headers == null) return null;
                    cache.put(kind, target, headers, bytes);
                    return headers;
                default:
                    return null;
            }
        }
    }

    /** True when the server sent a different shell, now kept. */
    private boolean fetchShell(String target, TunnelStream stream, BundleCache.Entry old) throws IOException, InterruptedException {
        // A 304 keeps nothing: the shell on the phone is current.
        if (fetchInto(BundleCache.Kind.SHELL, target, stream) == null) return false;
        BundleCache.Entry kept = cache.get(BundleCache.Kind.SHELL, target);
        if (kept == null) return false;
        prefetch(kept.body);
        // cezar sends no ETag on its shell, so the ~10 KB itself is what is compared.
        return !Arrays.equals(old.body, kept.body);
    }

    /** A stalled SSE page that went away must give its stream back, or 32 of them end the session's use. */
    private static boolean clientLeft(Socket socket, InputStream in) throws IOException {
        int timeout = socket.getSoTimeout();
        socket.setSoTimeout(1);
        try {
            in.mark(1);
            int b = in.read();
            if (b == -1) return true;
            in.reset();
            return false;
        } catch (SocketTimeoutException e) {
            return false;
        } finally {
            socket.setSoTimeout(timeout);
        }
    }

    private static String headerOf(List<TunnelFrame.Header> headers, String name) {
        for (TunnelFrame.Header header : headers) if (header.name.equals(name)) return header.value;
        return null;
    }

    private static void writeHead(OutputStream out, ProxyRequest request, TunnelStream.Event head, boolean chunked) throws IOException {
        StringBuilder text = new StringBuilder("HTTP/1.1 ").append(head.status).append(' ').append(reason(head.status)).append("\r\n");
        for (TunnelFrame.Header header : head.headers) {
            if (DROPPED_RESPONSE.contains(header.name)) continue;
            text.append(header.name).append(": ").append(header.value).append("\r\n");
        }
        text.append(CONTENT_SECURITY_POLICY);
        if (chunked) text.append("transfer-encoding: chunked\r\n");
        text.append("\r\n");
        out.write(text.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 431: return "Request Header Fields Too Large";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }

    private static void plain(OutputStream out, int status, String extra, boolean close) throws IOException {
        String text = "HTTP/1.1 " + status + " " + reason(status) + "\r\ncontent-length: 0\r\ncache-control: no-store\r\n"
                + (extra == null ? "" : extra) + (close ? "connection: close\r\n" : "") + "\r\n";
        out.write(Bytes.ascii(text));
        out.flush();
    }
}
