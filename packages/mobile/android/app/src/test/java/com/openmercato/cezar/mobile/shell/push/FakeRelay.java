package com.openmercato.cezar.mobile.shell.push;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;

/** The relay's push routes, scripted. An empty script is a network failure. */
final class FakeRelay implements PushRelay {
    static final class Sent {
        final String url;
        final Map<String, String> headers;
        final byte[] body;

        Sent(String url, Map<String, String> headers, byte[] body) {
            this.url = url;
            this.headers = headers;
            this.body = body;
        }
    }

    final Deque<Answer> answers = new ArrayDeque<>();
    final List<Sent> sent = new ArrayList<>();

    FakeRelay answer(int status, String body) {
        answers.add(new Answer(status, null, -1, -1, body));
        return this;
    }

    FakeRelay answer(Answer answer) {
        answers.add(answer);
        return this;
    }

    static String grant(String grantId, long expiresAt) {
        return "{\"grant\":\"sealed-" + grantId + "\",\"grantId\":\"" + grantId + "\",\"expiresAt\":" + expiresAt + "}";
    }

    @Override
    public Answer post(String url, Map<String, String> headers, byte[] body) throws IOException {
        sent.add(new Sent(url, headers, body));
        if (answers.isEmpty()) throw new IOException("offline");
        return answers.poll();
    }
}
