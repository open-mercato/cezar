package com.openmercato.cezar.mobile.shell;

/** Whether a server page has drawn: one of the launch view's exits, never the only one (StartupWatchdog). */
public final class FirstPaint {
    /** Asked with evaluateJavascript. The cockpit renders into `#root`; a sign-in page has none; the webview's first about:blank never counts. */
    public static final String SCRIPT = "(function(){var r=document.getElementById('root');if(location.protocol.indexOf('http')!==0)return false;"
            + "return document.readyState!=='loading'&&(r?r.childElementCount>0:document.readyState==='complete');})()";
    public static final long POLL_MS = 100;

    private FirstPaint() {}
}
