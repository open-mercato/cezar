package com.openmercato.cezar.mobile.shell.relay;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** One HTTP/1.1 request head and its body, read strictly: other apps can reach this port too. */
final class ProxyRequest {
    /** Answer this status and close, with nothing sent into the tunnel. */
    static final class Refused extends IOException {
        final int status;

        Refused(int status) {
            super("refused " + status);
            this.status = status;
        }
    }

    private static final int MAX_HEAD = 32768;
    private static final Pattern LINE = Pattern.compile("([A-Z]+) ([^ ]+) HTTP/1\\.([01])");
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9!#$%&'*+.^_`|~-]+");

    final String method;
    final String target;
    final boolean http11;
    final List<TunnelFrame.Header> headers;
    private final InputStream in;
    private long left;
    private final boolean chunked;
    private boolean chunkDone;

    private ProxyRequest(String method, String target, boolean http11, List<TunnelFrame.Header> headers, InputStream in) throws Refused {
        this.method = method;
        this.target = target;
        this.http11 = http11;
        this.headers = headers;
        this.in = in;
        List<String> lengths = all("content-length");
        List<String> encodings = all("transfer-encoding");
        if (lengths.size() > 1 || (!lengths.isEmpty() && !encodings.isEmpty()) || encodings.size() > 1) throw new Refused(400);
        chunked = !encodings.isEmpty();
        if (chunked && !encodings.get(0).equalsIgnoreCase("chunked")) throw new Refused(400);
        if (!lengths.isEmpty()) {
            try {
                if (!lengths.get(0).matches("[0-9]{1,18}")) throw new NumberFormatException();
                left = Long.parseLong(lengths.get(0));
            } catch (NumberFormatException e) {
                throw new Refused(400);
            }
        }
    }

    /** Null on a clean end of the connection. */
    static ProxyRequest read(InputStream in) throws IOException {
        int[] budget = {MAX_HEAD};
        String first = line(in, budget, true);
        if (first == null) return null;
        Matcher match = LINE.matcher(first);
        if (!match.matches()) throw new Refused(400);
        List<TunnelFrame.Header> headers = new ArrayList<>();
        while (true) {
            String line = line(in, budget, false);
            if (line == null) throw new Refused(400);
            if (line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon <= 0 || !NAME.matcher(line.substring(0, colon)).matches()) throw new Refused(400);
            String value = trim(line.substring(colon + 1));
            if (!TunnelFrame.validHeaderValue(value)) throw new Refused(400);
            headers.add(new TunnelFrame.Header(line.substring(0, colon).toLowerCase(Locale.ROOT), value));
        }
        return new ProxyRequest(match.group(1), match.group(2), match.group(3).equals("1"), headers, in);
    }

    private static String trim(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && (value.charAt(start) == ' ' || value.charAt(start) == '\t')) start++;
        while (end > start && (value.charAt(end - 1) == ' ' || value.charAt(end - 1) == '\t')) end--;
        return value.substring(start, end);
    }

    /** CRLF only: a bare LF is the classic smuggling split. */
    private static String line(InputStream in, int[] budget, boolean first) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        while (true) {
            int b = in.read();
            if (b == -1) {
                if (first && out.size() == 0) return null;
                throw new Refused(400);
            }
            if (--budget[0] < 0) throw new Refused(431);
            if (b == '\n') throw new Refused(400);
            if (b == '\r') {
                if (in.read() != '\n') throw new Refused(400);
                String text = new String(out.toByteArray(), StandardCharsets.ISO_8859_1);
                if (!text.isEmpty() && (text.charAt(0) == ' ' || text.charAt(0) == '\t')) throw new Refused(400);
                return text;
            }
            out.write(b);
        }
    }

    String header(String name) {
        for (TunnelFrame.Header header : headers) if (header.name.equals(name)) return header.value;
        return null;
    }

    List<String> all(String name) {
        List<String> out = new ArrayList<>();
        for (TunnelFrame.Header header : headers) if (header.name.equals(name)) out.add(header.value);
        return out;
    }

    /** Fewer bytes than the body has left, -1 at its end. A short body throws. */
    int readBody(byte[] buffer) throws IOException {
        if (chunked ? chunkDone : left == 0) return -1;
        if (chunked && left == 0) {
            left = chunkSize();
            if (left == 0) {
                while (true) {
                    int[] budget = {MAX_HEAD};
                    String trailer = line(in, budget, false);
                    if (trailer == null || trailer.isEmpty()) break;
                }
                chunkDone = true;
                return -1;
            }
        }
        int count = in.read(buffer, 0, (int) Math.min(buffer.length, left));
        if (count < 0) throw new IOException("short body");
        left -= count;
        if (chunked && left == 0 && (in.read() != '\r' || in.read() != '\n')) throw new IOException("bad chunk");
        return count;
    }

    private long chunkSize() throws IOException {
        int[] budget = {64};
        String line = line(in, budget, false);
        int semi = line == null ? -1 : line.indexOf(';');
        String size = line == null ? "" : semi >= 0 ? line.substring(0, semi) : line;
        if (!size.matches("[0-9a-fA-F]{1,8}")) throw new IOException("bad chunk size");
        return Long.parseLong(size, 16);
    }
}
