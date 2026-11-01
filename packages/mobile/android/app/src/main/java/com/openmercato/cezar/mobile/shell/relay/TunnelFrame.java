package com.openmercato.cezar.mobile.shell.relay;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/** One tunnel frame, encoded and refused exactly as RELAY_PROTOCOL.md §§ 12, 13.1 say. */
public final class TunnelFrame {
    public static final int HELLO = 0, OPEN = 1, HEAD = 2, DATA = 3, END = 4, RESET = 5, WINDOW = 6, LEASE = 7, REKEY = 8, CLOSE = 9;
    public static final int RESET_CANCELLED = 1, RESET_FLOW_CONTROL = 2, RESET_BAD_REQUEST = 3, RESET_TOO_MANY_STREAMS = 4, RESET_HEAD_TOO_LARGE = 5, RESET_INTERNAL = 6;
    public static final int CLOSE_NORMAL = 1, CLOSE_GOODBYE = 2, CLOSE_LEASE_EXPIRED = 3, CLOSE_PROTOCOL_ERROR = 4, CLOSE_TUNNEL_UNSUPPORTED = 5, CLOSE_DEVICE_REMOVED = 6;
    public static final int MAX_WINDOW = 262144;
    /** An `OPEN` or `HEAD` frame's content limit, § 13.1. */
    public static final int MAX_HEAD_BYTES = 16000;
    public static final int MAX_TARGET_BYTES = 8192;
    public static final int MAX_NAME_BYTES = 255;

    private static final List<String> METHODS = Arrays.asList("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");
    private static final Pattern NAME = Pattern.compile("[a-z0-9!#$%&'*+.^_`|~-]+");

    public static final class Header {
        public final String name;
        public final String value;

        public Header(String name, String value) {
            this.name = name;
            this.value = value;
        }
    }

    public final int type;
    public int stream;
    public int min, max;
    public String method, target;
    public int status;
    public int code;
    public int increment;
    public byte[] data = new byte[0];
    public List<Header> headers = Collections.emptyList();

    private TunnelFrame(int type) {
        this.type = type;
    }

    public static boolean validMethod(String method) {
        return METHODS.contains(method);
    }

    /** One leading `/`, printable ASCII with no `\\`, within the limit (§ 13.1). */
    public static boolean validTarget(String target) {
        if (target.isEmpty() || target.length() > MAX_TARGET_BYTES || target.charAt(0) != '/' || target.startsWith("//")) return false;
        for (int i = 0; i < target.length(); i++) {
            char c = target.charAt(i);
            if (c <= ' ' || c >= 0x7f || c == '\\') return false;
        }
        return true;
    }

    public static boolean validHeaderValue(String value) {
        return value.indexOf('\r') < 0 && value.indexOf('\n') < 0 && value.indexOf('\0') < 0;
    }

    public static byte[] hello(int min, int max) {
        return ByteBuffer.allocate(5).put((byte) HELLO).putShort((short) min).putShort((short) max).array();
    }

    public static byte[] open(int stream, String method, String target, List<Header> headers) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(OPEN);
        int32(out, stream);
        str8(out, Bytes.ascii(method));
        byte[] path = Bytes.ascii(target);
        int16(out, path.length);
        out.write(path, 0, path.length);
        headers(out, headers);
        return out.toByteArray();
    }

    /** cezar's half: the client never sends it, but the vectors and the local test peer do. */
    public static byte[] head(int stream, int status, List<Header> headers) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(HEAD);
        int32(out, stream);
        int16(out, status);
        headers(out, headers);
        return out.toByteArray();
    }

    public static byte[] data(int stream, byte[] payload, int offset, int length) {
        return ByteBuffer.allocate(5 + length).put((byte) DATA).putInt(stream).put(payload, offset, length).array();
    }

    public static byte[] end(int stream) {
        return ByteBuffer.allocate(5).put((byte) END).putInt(stream).array();
    }

    public static byte[] reset(int stream, int code) {
        return ByteBuffer.allocate(7).put((byte) RESET).putInt(stream).putShort((short) code).array();
    }

    public static byte[] window(int stream, int increment) {
        return ByteBuffer.allocate(9).put((byte) WINDOW).putInt(stream).putInt(increment).array();
    }

    public static byte[] lease() {
        return new byte[] {LEASE};
    }

    public static byte[] rekey() {
        return new byte[] {REKEY};
    }

    public static byte[] close(int code) {
        return ByteBuffer.allocate(3).put((byte) CLOSE).putShort((short) code).array();
    }

    private static void int16(ByteArrayOutputStream out, int value) {
        out.write(value >>> 8);
        out.write(value);
    }

    private static void int32(ByteArrayOutputStream out, int value) {
        int16(out, value >>> 16);
        int16(out, value);
    }

    private static void str8(ByteArrayOutputStream out, byte[] bytes) {
        out.write(bytes.length);
        out.write(bytes, 0, bytes.length);
    }

    private static void headers(ByteArrayOutputStream out, List<Header> headers) {
        int16(out, headers.size());
        for (Header header : headers) {
            str8(out, Bytes.utf8(header.name));
            byte[] value = header.value.getBytes(StandardCharsets.ISO_8859_1);
            int16(out, value.length);
            out.write(value, 0, value.length);
        }
    }

    /** Any malformed frame is refused here, which the caller turns into a protocol error. */
    public static TunnelFrame parse(byte[] content) throws TunnelRecord.Malformed {
        if (content.length == 0) throw new TunnelRecord.Malformed("empty frame");
        ByteBuffer in = ByteBuffer.wrap(content);
        TunnelFrame frame = new TunnelFrame(in.get() & 0xff);
        try {
            switch (frame.type) {
                case HELLO:
                    frame.min = in.getShort() & 0xffff;
                    frame.max = in.getShort() & 0xffff;
                    break;
                case OPEN:
                    frame.stream = streamId(in);
                    frame.method = str(in, in.get() & 0xff);
                    frame.target = str(in, in.getShort() & 0xffff);
                    frame.headers = readHeaders(in);
                    if (!validMethod(frame.method) || !validTarget(frame.target)) throw new TunnelRecord.Malformed("bad OPEN");
                    break;
                case HEAD:
                    frame.stream = streamId(in);
                    frame.status = in.getShort() & 0xffff;
                    frame.headers = readHeaders(in);
                    if (frame.status < 200 || frame.status > 599) throw new TunnelRecord.Malformed("bad status");
                    break;
                case DATA:
                    frame.stream = streamId(in);
                    frame.data = new byte[in.remaining()];
                    in.get(frame.data);
                    break;
                case END:
                    frame.stream = streamId(in);
                    break;
                case RESET:
                    frame.stream = streamId(in);
                    frame.code = in.getShort() & 0xffff;
                    break;
                case WINDOW:
                    frame.stream = streamId(in);
                    frame.increment = in.getInt();
                    if (frame.increment < 1 || frame.increment > MAX_WINDOW) throw new TunnelRecord.Malformed("bad increment");
                    break;
                case LEASE:
                case REKEY:
                    break;
                case CLOSE:
                    frame.code = in.getShort() & 0xffff;
                    break;
                default:
                    throw new TunnelRecord.Malformed("unknown type");
            }
        } catch (java.nio.BufferUnderflowException | IllegalArgumentException e) {
            throw new TunnelRecord.Malformed("truncated frame");
        }
        if (in.hasRemaining()) throw new TunnelRecord.Malformed("trailing bytes");
        return frame;
    }

    private static int streamId(ByteBuffer in) throws TunnelRecord.Malformed {
        int id = in.getInt();
        if (id == 0) throw new TunnelRecord.Malformed("stream id zero");
        return id;
    }

    private static String str(ByteBuffer in, int length) {
        byte[] bytes = new byte[length];
        in.get(bytes);
        return new String(bytes, StandardCharsets.ISO_8859_1);
    }

    private static List<Header> readHeaders(ByteBuffer in) throws TunnelRecord.Malformed {
        int count = in.getShort() & 0xffff;
        List<Header> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String name = str(in, in.get() & 0xff);
            String value = str(in, in.getShort() & 0xffff);
            if (!NAME.matcher(name).matches() || !validHeaderValue(value)) throw new TunnelRecord.Malformed("bad header");
            out.add(new Header(name, value));
        }
        return out;
    }
}
