package com.openmercato.cezar.mobile.shell;

/** When the branded cover over a server page may go: the cockpit has drawn, or any other page has loaded. */
public final class FirstPaint {
    /** Asked with evaluateJavascript. The cockpit renders into `#root`; a sign-in page has none; the webview's first about:blank never counts. */
    public static final String SCRIPT = "(function(){var r=document.getElementById('root');if(location.protocol.indexOf('http')!==0)return false;"
            + "return document.readyState!=='loading'&&(r?r.childElementCount>0:document.readyState==='complete');})()";
    /** Never longer than this: a page that cannot paint must still be seen, banner and all. */
    public static final long MAX_COVER_MS = 15000;
    public static final long POLL_MS = 100;

    private FirstPaint() {}

    public static boolean done(String answer, long coveredMs) {
        return "true".equals(answer) || coveredMs >= MAX_COVER_MS;
    }
}
