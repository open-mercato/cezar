import Foundation

/// When the branded cover over a server page may go: the cockpit has drawn, or any other page has loaded.
enum FirstPaint {
    /// Asked with evaluateJavaScript; Android's `FirstPaint.SCRIPT` to the byte. The cockpit renders into `#root`; a sign-in page has none.
    static let script = "(function(){var r=document.getElementById('root');return document.readyState!=='loading'&&(r?r.childElementCount>0:document.readyState==='complete');})()"
    /// Never longer than this: a page that cannot paint must still be seen, banner and all.
    static let maxCoverMs: Int64 = 15000
    static let pollMs: Int64 = 100

    /// `answer` is what the script returned, nil when it could not run.
    static func done(_ answer: Any?, coveredMs: Int64) -> Bool {
        (answer as? Bool) == true || coveredMs >= maxCoverMs
    }
}
