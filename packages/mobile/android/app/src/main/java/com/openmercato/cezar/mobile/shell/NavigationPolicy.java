package com.openmercato.cezar.mobile.shell;

import java.util.Locale;

/** Which navigations stay in the server webview (spec "Other shell behaviour"). */
public final class NavigationPolicy {
    /** `SERVERS`, `RECONNECT` and `HAPTIC` are the page's only asks of the shell, by navigation, with no bridge. */
    public enum Action { ALLOW, EXTERNAL, SERVERS, RECONNECT, HAPTIC, BLOCK }

    private NavigationPolicy() {}

    public static Action decide(PageOrigin origin, String url, String pageUrl, boolean mainFrame, boolean redirect) {
        String scheme = schemeOf(url);
        if (scheme.equals("cezar")) {
            if (!mainFrame) return Action.BLOCK;
            String bare = url.toLowerCase(Locale.ROOT);
            if (bare.matches("cezar://servers/?")) return Action.SERVERS;
            if (bare.matches("cezar://reconnect/?")) return Action.RECONNECT;
            if (bare.matches("cezar://haptic/?")) return Action.HAPTIC;
            return Action.BLOCK;
        }
        if (scheme.equals("about") || scheme.equals("blob") || scheme.equals("data")) return Action.ALLOW;
        if (scheme.equals("mailto") || scheme.equals("tel")) return mainFrame ? Action.EXTERNAL : Action.BLOCK;
        if (!scheme.equals("https") && !scheme.equals("http")) return Action.BLOCK;
        if (origin.sameOrigin(url)) return Action.ALLOW;
        if (!mainFrame) return Action.ALLOW;
        // An SSO login leaves the origin by redirect and works on its own pages until it returns.
        // The responder still refuses every challenge off the origin.
        if (scheme.equals("https") && origin.allowsSso() && (redirect || !origin.sameOrigin(pageUrl))) return Action.ALLOW;
        return Action.EXTERNAL;
    }

    /** `window.open` and `target=_blank`: same origin stays here, the rest leave the app. */
    public static Action decideWindow(PageOrigin origin, String url) {
        if (origin.sameOrigin(url)) return Action.ALLOW;
        String scheme = schemeOf(url);
        boolean external = scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto") || scheme.equals("tel");
        return external ? Action.EXTERNAL : Action.BLOCK;
    }

    private static String schemeOf(String url) {
        UrlParts parts = UrlParts.parse(url);
        return parts == null ? "" : parts.scheme;
    }
}
