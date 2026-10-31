package com.openmercato.cezar.mobile.shell;

import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** One HTTP response. Header names are lower case. */
public final class HttpAnswer {
    public final int status;
    public final Map<String, List<String>> headers;
    public final String body;

    public HttpAnswer(int status, Map<String, List<String>> headers, String body) {
        this.status = status;
        this.headers = headers;
        this.body = body;
    }

    List<String> headers(String name) {
        List<String> values = headers.get(name.toLowerCase(Locale.ROOT));
        return values == null ? Collections.<String>emptyList() : values;
    }
}
