package com.openmercato.cezar.mobile.shell.push;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Enough of `text/event-stream` for `/workspace/phone/signals` (spec R5, Stage 1): `event` and `data`
 * fields, comments, and a blank line that ends an event. Bytes may arrive split anywhere.
 */
public final class SignalParser {
    public interface Events {
        void event(String type, String data);
    }

    /** cezar's events are a few dozen bytes. A longer line spoils its event instead of growing a buffer. */
    static final int MAX_LINE = 4096;

    private final Events events;
    private final ByteArrayOutputStream line = new ByteArrayOutputStream();
    private boolean afterCr;
    private boolean overlong;
    private boolean broken;
    private String type = "";
    private StringBuilder data;

    public SignalParser(Events events) {
        this.events = events;
    }

    public void feed(byte[] bytes, int offset, int length) {
        for (int i = offset; i < offset + length; i++) {
            byte b = bytes[i];
            if (afterCr) {
                afterCr = false;
                if (b == '\n') continue;
            }
            if (b == '\r') {
                afterCr = true;
                endLine();
            } else if (b == '\n') {
                endLine();
            } else if (line.size() < MAX_LINE) {
                line.write(b);
            } else {
                overlong = true;
            }
        }
    }

    private void endLine() {
        String text = new String(line.toByteArray(), StandardCharsets.UTF_8);
        line.reset();
        if (overlong) {
            overlong = false;
            broken = true;
            return;
        }
        if (text.isEmpty()) {
            dispatch();
            return;
        }
        if (text.charAt(0) == ':') return;
        int colon = text.indexOf(':');
        String field = colon < 0 ? text : text.substring(0, colon);
        String value = colon < 0 ? "" : text.substring(colon + 1);
        if (value.startsWith(" ")) value = value.substring(1);
        if ("event".equals(field)) {
            type = value;
        } else if ("data".equals(field)) {
            if (data == null) data = new StringBuilder();
            else data.append('\n');
            data.append(value);
        }
    }

    private void dispatch() {
        boolean any = data != null || !type.isEmpty();
        String eventType = type.isEmpty() ? "message" : type;
        String eventData = data == null ? "" : data.toString();
        boolean spoiled = broken;
        type = "";
        data = null;
        broken = false;
        if (any && !spoiled) events.event(eventType, eventData);
    }
}
