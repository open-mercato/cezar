package com.openmercato.cezar.mobile.shell;

/** What the gates need from either kind of server page: {@link ServerOrigin} or {@link ProxyOrigin}. */
public interface PageOrigin {
    String origin();
    String url(String path);
    boolean sameOrigin(String url);
    boolean sameHost(String url);
    /** Whether an `https` redirect may leave in-app, for an SSO login. Manual servers only. */
    boolean allowsSso();
}
