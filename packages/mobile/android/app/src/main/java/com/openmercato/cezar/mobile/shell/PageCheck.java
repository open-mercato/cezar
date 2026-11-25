package com.openmercato.cezar.mobile.shell;

/**
 * What a server page shows right now (iOS's PageCheck). {@code blank} is the black screen: the cockpit's
 * document loaded and its {@code #root} stayed empty, as when a shell names bundle files the server no
 * longer has, or the app crashed while booting.
 */
public final class PageCheck {
    public static final String NONE = "none";
    public static final String LOADING = "loading";
    public static final String PAINTED = "painted";
    public static final String BLANK = "blank";
    public static final String PAGE = "page";

    /** Asked with evaluateJavascript; iOS's `PageCheck.script` to the byte. */
    public static final String SCRIPT = "(function(){if(location.protocol.indexOf('http')!==0)return 'none';if(document.readyState==='loading')return 'loading';"
            + "var r=document.getElementById('root');if(r)return r.childElementCount>0?'painted':'blank';return document.readyState==='complete'?'page':'loading';})()";

    private PageCheck() {}

    /** evaluateJavascript's JSON answer as a state, null when the script could not run. */
    public static String state(String answer) {
        if (answer == null) return null;
        switch (answer) {
            case "\"none\"": return NONE;
            case "\"loading\"": return LOADING;
            case "\"painted\"": return PAINTED;
            case "\"blank\"": return BLANK;
            case "\"page\"": return PAGE;
            default: return null;
        }
    }

    /** A relay page is always the cockpit, so one with no {@code #root} is the proxy's error page. */
    public static boolean healthy(String state, boolean expectsRoot) {
        return PAINTED.equals(state) || (PAGE.equals(state) && !expectsRoot);
    }
}
