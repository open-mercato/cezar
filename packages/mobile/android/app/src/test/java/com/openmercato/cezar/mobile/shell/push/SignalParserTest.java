package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** `/workspace/phone/signals` as cezar writes it, in whatever pieces the tunnel delivers (spec R5, Stage 1). */
public class SignalParserTest {
    private final List<String> events = new ArrayList<>();
    private final SignalParser parser = new SignalParser((type, data) -> events.add(type + "|" + data));

    private void feed(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        parser.feed(bytes, 0, bytes.length);
    }

    @Test
    public void readySignalAndPingAsCezarSendsThem() {
        feed("event: ready\ndata: {}\n\n");
        feed("event: signal\ndata: {\"managerId\":\"mgr_1\"}\n\n");
        feed("event: signal\ndata: {}\n\n");
        feed("event: ping\ndata: \n\n");
        assertEquals(Arrays.asList("ready|{}", "signal|{\"managerId\":\"mgr_1\"}", "signal|{}", "ping|"), events);
    }

    @Test
    public void commentsAndUnknownFieldsAreIgnored() {
        feed(": keep-alive\n\nid: 7\nretry: 1000\nevent: signal\n: in the middle\ndata: {}\n\n");
        assertEquals(Arrays.asList("signal|{}"), events);
    }

    @Test
    public void anyPieceSizeAndLineEndingGivesTheSameEvents() {
        String wire = "event: ready\r\ndata: {}\r\n\r\nevent: signal\rdata: {\"managerId\":\"é\"}\r\revent: ping\ndata:\n\n";
        byte[] bytes = wire.getBytes(StandardCharsets.UTF_8);
        for (int size = 1; size <= bytes.length; size++) {
            events.clear();
            SignalParser split = new SignalParser((type, data) -> events.add(type + "|" + data));
            for (int at = 0; at < bytes.length; at += size) split.feed(bytes, at, Math.min(size, bytes.length - at));
            assertEquals("pieces of " + size, Arrays.asList("ready|{}", "signal|{\"managerId\":\"é\"}", "ping|"), events);
        }
    }

    @Test
    public void malformedInputNeverDispatchesHalfAnEvent() {
        feed("event: signal\ndata: {}");
        assertEquals("no blank line yet", 0, events.size());
        feed("\n\n\n\n");
        assertEquals("blank lines alone are nothing", Arrays.asList("signal|{}"), events);
        events.clear();
        feed("garbage\n{\"managerId\":\"x\"}\n\n");
        assertEquals("unknown fields make no event", 0, events.size());
        StringBuilder huge = new StringBuilder("event: signal\ndata: ");
        for (int i = 0; i < SignalParser.MAX_LINE + 10; i++) huge.append('x');
        feed(huge + "\n\nevent: signal\ndata: {}\n\n");
        assertEquals("an overlong line spoils only its own event", Arrays.asList("signal|{}"), events);
    }

    @Test
    public void multipleDataLinesJoinWithNewlines() {
        feed("event: signal\ndata: {\ndata: }\n\n");
        assertEquals(Arrays.asList("signal|{\n}"), events);
    }
}
