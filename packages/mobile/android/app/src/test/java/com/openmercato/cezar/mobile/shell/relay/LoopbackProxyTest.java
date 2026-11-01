package com.openmercato.cezar.mobile.shell.relay;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The proxy over a real socket and a real session, with an in-memory cezar on the far side. */
public class LoopbackProxyTest {
    /** Decrypts what the session sends and hands each frame to `handler`, on one thread like the real peer. */
    private final class Peer {
        final NoiseCipher receive;
        final NoiseCipher send;
        final ExecutorService thread = Executors.newSingleThreadExecutor();
        final Map<Integer, ByteArrayOutputStream> bodies = new ConcurrentHashMap<>();
        final LinkedBlockingQueue<TunnelFrame> opened = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<Integer> ended = new LinkedBlockingQueue<>();
        final LinkedBlockingQueue<TunnelFrame> resets = new LinkedBlockingQueue<>();
        volatile int dataBytes;
        volatile int credit = -1;

        Peer(NoiseCipher receive, NoiseCipher send) {
            this.receive = receive;
            this.send = send;
        }

        void onWire(byte[] ciphertext) {
            thread.execute(() -> {
                try {
                    handle(TunnelFrame.parse(TunnelRecord.unpad(receive.decrypt(ciphertext))));
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            });
        }

        void handle(TunnelFrame frame) {
            switch (frame.type) {
                case TunnelFrame.OPEN:
                    bodies.put(frame.stream, new ByteArrayOutputStream());
                    opened.add(frame);
                    break;
                case TunnelFrame.DATA:
                    bodies.get(frame.stream).write(frame.data, 0, frame.data.length);
                    dataBytes += frame.data.length;
                    if (credit != 0) reply(TunnelFrame.window(frame.stream, frame.data.length));
                    break;
                case TunnelFrame.END:
                    ended.add(frame.stream);
                    break;
                case TunnelFrame.RESET:
                    resets.add(frame);
                    break;
                default:
                    break;
            }
        }

        void reply(byte[] content) {
            session.receive(send.encrypt(TunnelRecord.pad(content)));
        }

        void head(int stream, int status, String... pairs) {
            List<TunnelFrame.Header> headers = new ArrayList<>();
            for (int i = 0; i < pairs.length; i += 2) headers.add(new TunnelFrame.Header(pairs[i], pairs[i + 1]));
            reply(TunnelFrame.head(stream, status, headers));
        }

        void data(int stream, byte[] bytes) {
            reply(TunnelFrame.data(stream, bytes, 0, bytes.length));
        }
    }

    private TunnelSession session;
    private Peer peer;
    private LoopbackProxy proxy;
    private volatile boolean sessionUp = true;
    private final List<Socket> sockets = new ArrayList<>();

    @Before
    public void build() throws Exception {
        byte[] toCezar = RelayCrypto.random(32);
        byte[] toPhone = RelayCrypto.random(32);
        peer = new Peer(new NoiseCipher(toCezar), new NoiseCipher(toPhone));
        session = new TunnelSession(peer::onWire, new NoiseHandshake.Keys(new NoiseCipher(toCezar), new NoiseCipher(toPhone)), 65552, code -> { }, System::currentTimeMillis);
        session.start();
        proxy = new LoopbackProxy(() -> sessionUp ? session : null, "CezarMobile/0.1.0 (android)");
        proxy.open(0);
    }

    @After
    public void stop() throws IOException {
        proxy.close();
        for (Socket socket : sockets) socket.close();
    }

    private Socket connect() throws IOException {
        Socket socket = new Socket(InetAddress.getByName("127.0.0.1"), proxy.port());
        socket.setSoTimeout(5000);
        sockets.add(socket);
        return socket;
    }

    private String gated(String method, String target, String extra) {
        return method + " " + target + " HTTP/1.1\r\nHost: 127.0.0.1:" + proxy.port() + "\r\nCookie: " + LoopbackProxy.COOKIE + "=" + proxy.cookieValue() + "\r\n" + extra + "\r\n";
    }

    private static void send(Socket socket, String text) throws IOException {
        socket.getOutputStream().write(text.getBytes(StandardCharsets.ISO_8859_1));
        socket.getOutputStream().flush();
    }

    private static String readHead(InputStream in) throws IOException {
        StringBuilder out = new StringBuilder();
        while (!out.toString().endsWith("\r\n\r\n")) {
            int b = in.read();
            if (b == -1) break;
            out.append((char) b);
        }
        return out.toString();
    }

    private void refused(String request, String status) throws Exception {
        Socket socket = connect();
        send(socket, request);
        assertTrue(request, readHead(socket.getInputStream()).startsWith("HTTP/1.1 " + status));
        assertNull("nothing enters the tunnel", peer.opened.poll(100, TimeUnit.MILLISECONDS));
    }

    @Test
    public void theGateRefusesBeforeTheTunnel() throws Exception {
        String host = "Host: 127.0.0.1:" + proxy.port() + "\r\n";
        String cookie = "Cookie: " + LoopbackProxy.COOKIE + "=" + proxy.cookieValue() + "\r\n";
        refused("GET / HTTP/1.1\r\n" + host + "\r\n", "403");
        refused("GET / HTTP/1.1\r\n" + host + "Cookie: " + LoopbackProxy.COOKIE + "=wrong\r\n\r\n", "403");
        refused("GET / HTTP/1.1\r\nHost: localhost:" + proxy.port() + "\r\n" + cookie + "\r\n", "403");
        refused("GET / HTTP/1.1\r\nHost: evil.example\r\n" + cookie + "\r\n", "403");
        refused("GET / HTTP/1.1\r\n" + cookie + "\r\n", "403");
        refused(gated("POST", "/x", "Origin: http://127.0.0.1:1\r\n"), "403");
        refused(gated("POST", "/x", "Origin: null\r\n"), "403");
        refused(gated("GET", "/x", "Sec-Fetch-Site: same-site\r\n"), "403");
        refused(gated("GET", "/x", "Sec-Fetch-Site: cross-site\r\n"), "403");
        refused(gated("GET", "/x", "Upgrade: websocket\r\nConnection: Upgrade\r\n"), "400");
        refused(gated("CONNECT", "/x", ""), "405");
        refused(gated("GET", "http://evil/x", ""), "400");
        refused(gated("GET", "//evil/x", ""), "400");
    }

    @Test
    public void malformedRequestsAreRefused() throws Exception {
        refused("GET / HTTP/1.1\nHost: x\n\n", "400");
        refused(gated("POST", "/x", "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n"), "400");
        refused(gated("POST", "/x", "Content-Length: 1\r\nContent-Length: 2\r\n"), "400");
        refused(gated("GET", "/" + new String(new char[9000]).replace('\0', 'a'), ""), "431");
    }

    @Test
    public void headersAreDroppedAndTheUserAgentReplaced() throws Exception {
        Socket socket = connect();
        send(socket, gated("GET", "/api/x?y=1", "Origin: http://127.0.0.1:" + proxy.port() + "\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nAuthorization: Basic x\r\nX-Forwarded-For: 1.2.3.4\r\nX-Real-IP: 1.2.3.4\r\nForwarded: for=1\r\nX-Cezar-Runtime-Handoff: t\r\nUser-Agent: webview\r\nAccept: */*\r\n"));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        assertEquals("GET", open.method);
        assertEquals("/api/x?y=1", open.target);
        List<String> seen = new ArrayList<>();
        for (TunnelFrame.Header header : open.headers) seen.add(header.name + "=" + header.value);
        assertEquals(Arrays.asList("accept=*/*", "user-agent=CezarMobile/0.1.0 (android)"), seen);
        assertEquals(Integer.valueOf(open.stream), peer.ended.poll(2, TimeUnit.SECONDS));
        peer.head(open.stream, 200, "content-length", "2", "set-cookie", "a=1", "www-authenticate", "Basic realm=x", "connection", "keep-alive");
        peer.data(open.stream, new byte[] {'o', 'k'});
        peer.reply(TunnelFrame.end(open.stream));
        String head = readHead(socket.getInputStream());
        assertTrue(head, head.startsWith("HTTP/1.1 200"));
        assertTrue(head, head.contains("content-length: 2"));
        assertFalse(head, head.contains("set-cookie"));
        assertFalse(head, head.contains("www-authenticate"));
        assertEquals('o', socket.getInputStream().read());
    }

    /** Approvals depend on this: a POST larger than one tunnel frame arrives whole, in order. */
    @Test
    public void aPostLargerThanOneFrameArrivesIntact() throws Exception {
        byte[] body = RelayCrypto.random(200000);
        Socket socket = connect();
        send(socket, gated("POST", "/api/approve", "Content-Type: application/octet-stream\r\nContent-Length: " + body.length + "\r\n"));
        socket.getOutputStream().write(body);
        socket.getOutputStream().flush();
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        assertEquals(Integer.valueOf(open.stream), peer.ended.poll(5, TimeUnit.SECONDS));
        assertArrayEquals(body, peer.bodies.get(open.stream).toByteArray());
        boolean kept = false;
        for (TunnelFrame.Header header : open.headers) kept |= header.name.equals("content-length") && header.value.equals("200000");
        assertTrue(kept);
    }

    @Test
    public void aChunkedBodyIsDecodedBeforeFraming() throws Exception {
        Socket socket = connect();
        send(socket, gated("POST", "/x", "Transfer-Encoding: chunked\r\n") + "5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n");
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        assertEquals(Integer.valueOf(open.stream), peer.ended.poll(2, TimeUnit.SECONDS));
        assertEquals("hello world", peer.bodies.get(open.stream).toString("UTF-8"));
    }

    @Test
    public void aBodyShorterThanItsLengthIsResetAndNeverEnded() throws Exception {
        Socket socket = connect();
        send(socket, gated("POST", "/x", "Content-Length: 10\r\n") + "abc");
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        socket.shutdownOutput();
        TunnelFrame reset = peer.resets.poll(2, TimeUnit.SECONDS);
        assertEquals(TunnelFrame.RESET_BAD_REQUEST, reset.code);
        assertEquals(open.stream, reset.stream);
        assertNull(peer.ended.poll(100, TimeUnit.MILLISECONDS));
    }

    @Test
    public void uploadStopsAtTheWindow() throws Exception {
        peer.credit = 0;
        byte[] body = new byte[400000];
        Socket socket = connect();
        send(socket, gated("POST", "/x", "Content-Length: " + body.length + "\r\n"));
        Thread writer = new Thread(() -> {
            try {
                socket.getOutputStream().write(body);
            } catch (IOException e) {
                // closed at the end of the test
            }
        });
        writer.setDaemon(true);
        writer.start();
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        Thread.sleep(500);
        assertEquals(TunnelFrame.MAX_WINDOW, peer.dataBytes);
        peer.reply(TunnelFrame.window(open.stream, 1000));
        Thread.sleep(200);
        assertEquals(TunnelFrame.MAX_WINDOW + 1000, peer.dataBytes);
    }

    /** SSE: bytes reach the page as they arrive, with the stream still open. */
    @Test
    public void streamingResponsesAreNotBuffered() throws Exception {
        Socket socket = connect();
        send(socket, gated("GET", "/events", "Accept: text/event-stream\r\n"));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 200, "content-type", "text/event-stream");
        InputStream in = socket.getInputStream();
        String head = readHead(in);
        assertTrue(head, head.contains("transfer-encoding: chunked"));
        for (String event : new String[] {"data: 1\n\n", "data: 2\n\n"}) {
            peer.data(open.stream, event.getBytes(StandardCharsets.UTF_8));
            byte[] chunk = new byte[64];
            int count = in.read(chunk);
            assertTrue(new String(chunk, 0, count, StandardCharsets.UTF_8), new String(chunk, 0, count, StandardCharsets.UTF_8).contains(event));
        }
    }

    @Test
    public void creditFollowsTheConsumerSoAStalledPageStallsTheSender() throws Exception {
        Socket socket = connect();
        send(socket, gated("GET", "/big", ""));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 200);
        // Nothing reads the socket: past the window a sender is reset, never buffered without bound.
        socket.setReceiveBufferSize(1024);
        for (int i = 0; i < 40; i++) {
            if (peer.resets.peek() != null) break;
            peer.data(open.stream, new byte[60000]);
            Thread.sleep(5);
        }
        TunnelFrame reset = peer.resets.poll(3, TimeUnit.SECONDS);
        assertEquals(TunnelFrame.RESET_FLOW_CONTROL, reset.code);
    }

    @Test
    public void aResetBeforeHeadIs502AndTooManyStreamsIs503() throws Exception {
        Socket socket = connect();
        send(socket, gated("GET", "/a", ""));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.reply(TunnelFrame.reset(open.stream, TunnelFrame.RESET_INTERNAL));
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 502"));
        Socket second = connect();
        send(second, gated("GET", "/b", ""));
        TunnelFrame next = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.reply(TunnelFrame.reset(next.stream, TunnelFrame.RESET_TOO_MANY_STREAMS));
        String head = readHead(second.getInputStream());
        assertTrue(head, head.startsWith("HTTP/1.1 503"));
        assertTrue(head, head.contains("retry-after: 1"));
    }

    @Test
    public void aLostSessionBeforeHeadIs502AndAfterHeadAbortsTheRead() throws Exception {
        Socket waiting = connect();
        send(waiting, gated("POST", "/approve", "Content-Length: 0\r\n"));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        Socket streaming = connect();
        send(streaming, gated("GET", "/events", ""));
        TunnelFrame events = peer.opened.poll(2, TimeUnit.SECONDS);
        assertNotEquals(open.stream, events.stream);
        peer.head(events.stream, 200, "content-type", "text/event-stream");
        InputStream in = streaming.getInputStream();
        readHead(in);
        session.end();
        assertTrue(readHead(waiting.getInputStream()).startsWith("HTTP/1.1 502"));
        assertEquals(-1, in.read());
        assertNull("a write is never retried", peer.opened.poll(200, TimeUnit.MILLISECONDS));
    }

    /** A complete early answer, such as a 413, survives the RESET that follows cezar's END (§ 13.2). */
    @Test
    public void aResetAfterEndDoesNotAbortACompleteResponse() throws Exception {
        Socket socket = connect();
        send(socket, gated("POST", "/x", "Content-Length: 5\r\n") + "abc");
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 413, "content-length", "2");
        peer.data(open.stream, new byte[] {'n', 'o'});
        peer.reply(TunnelFrame.end(open.stream));
        peer.reply(TunnelFrame.reset(open.stream, TunnelFrame.RESET_CANCELLED));
        send(socket, "de");
        InputStream in = socket.getInputStream();
        assertTrue(readHead(in).startsWith("HTTP/1.1 413"));
        assertEquals('n', in.read());
        assertEquals('o', in.read());
    }

    @Test
    public void noSessionIs503() throws Exception {
        sessionUp = false;
        Socket socket = connect();
        send(socket, gated("GET", "/", ""));
        String head = readHead(socket.getInputStream());
        assertTrue(head, head.startsWith("HTTP/1.1 503"));
        assertTrue(head, head.contains("retry-after: 1"));
    }

    @Test
    public void inTheBackgroundThePortStaysBoundAndAnswers503() throws Exception {
        Socket streaming = connect();
        send(streaming, gated("GET", "/events", ""));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 200);
        InputStream in = streaming.getInputStream();
        readHead(in);
        proxy.setServing(false);
        assertEquals("live streams die", -1, in.read());
        Socket socket = connect();
        send(socket, gated("GET", "/", ""));
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 503"));
        assertNull(peer.opened.poll(100, TimeUnit.MILLISECONDS));
        proxy.setServing(true);
        Socket back = connect();
        send(back, gated("GET", "/", ""));
        assertEquals("GET", peer.opened.poll(2, TimeUnit.SECONDS).method);
    }

    @Test
    public void aTakenPortGetsANewPortAndANewCookie() throws Exception {
        try (ServerSocket hostile = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            LoopbackProxy second = new LoopbackProxy(() -> session, "ua");
            int port = second.open(hostile.getLocalPort());
            assertTrue(second.rebound());
            assertNotEquals(hostile.getLocalPort(), port);
            assertNotEquals(proxy.cookieValue(), second.cookieValue());
            second.close();
        }
    }

    @Test
    public void aFreeSavedPortIsKept() throws Exception {
        int port;
        try (ServerSocket probe = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = probe.getLocalPort();
        }
        LoopbackProxy second = new LoopbackProxy(() -> session, "ua");
        assertEquals(port, second.open(port));
        assertFalse(second.rebound());
        second.close();
    }

    @Test
    public void headAndNoContentHaveNoBody() throws Exception {
        Socket socket = connect();
        send(socket, gated("HEAD", "/x", ""));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 200, "content-length", "100");
        peer.reply(TunnelFrame.end(open.stream));
        InputStream in = socket.getInputStream();
        assertTrue(readHead(in).contains("content-length: 100"));
        send(socket, gated("GET", "/y", ""));
        TunnelFrame next = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(next.stream, 204);
        peer.reply(TunnelFrame.end(next.stream));
        String head = readHead(in);
        assertTrue(head, head.startsWith("HTTP/1.1 204"));
        assertFalse(head, head.contains("transfer-encoding"));
    }

    @Test
    public void aClientThatLeavesGivesItsStreamBack() throws Exception {
        Socket socket = connect();
        send(socket, gated("GET", "/events", ""));
        TunnelFrame open = peer.opened.poll(2, TimeUnit.SECONDS);
        peer.head(open.stream, 200);
        readHead(socket.getInputStream());
        socket.close();
        TunnelFrame reset = peer.resets.poll(4, TimeUnit.SECONDS);
        assertEquals(open.stream, reset.stream);
        assertEquals(TunnelFrame.RESET_CANCELLED, reset.code);
    }

    @Test
    public void aFrameForAStreamNeverOpenedEndsTheSession() {
        peer.reply(TunnelFrame.window(1, 1));
        assertFalse(session.live());
    }

    @Test
    public void thirtyThreeStreamsAreRefusedLocally() throws Exception {
        for (int i = 0; i < TunnelSession.MAX_STREAMS; i++) session.open("GET", "/" + i, Collections.<TunnelFrame.Header>emptyList());
        Socket socket = connect();
        send(socket, gated("GET", "/x", ""));
        assertTrue(readHead(socket.getInputStream()).startsWith("HTTP/1.1 503"));
    }

    @Test(expected = SocketTimeoutException.class)
    public void nothingAnswersAnUnfinishedHead() throws Exception {
        Socket socket = connect();
        socket.setSoTimeout(300);
        send(socket, "GET / HTTP/1.1\r\n");
        socket.getInputStream().read();
    }
}
