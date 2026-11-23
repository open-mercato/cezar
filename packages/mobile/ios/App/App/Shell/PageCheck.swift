import Foundation

/// What a server page shows right now, asked with evaluateJavaScript. Android's `PageCheck.SCRIPT` to the
/// byte. `blank` is the black screen: the cockpit's document loaded and its `#root` stayed empty, as when
/// a shell names bundle files the server no longer has, or the app crashed while booting.
enum PageCheck {
    enum State: String { case none, loading, painted, blank, page }

    static let script = "(function(){if(location.protocol.indexOf('http')!==0)return 'none';if(document.readyState==='loading')return 'loading';var r=document.getElementById('root');if(r)return r.childElementCount>0?'painted':'blank';return document.readyState==='complete'?'page':'loading';})()"

    /// `answer` is what the script returned; nil when it could not run (a dead content process).
    static func state(_ answer: Any?) -> State? {
        (answer as? String).flatMap(State.init(rawValue:))
    }

    /// Whether the page is something the user can use. A relay page is always the cockpit, so a page
    /// with no `#root` there is a proxy error page; a URL server may show a sign-in page with none.
    static func healthy(_ state: State?, expectsRoot: Bool) -> Bool {
        state == .painted || (state == .page && !expectsRoot)
    }
}
