// See notch-snapshots.mjs: one offscreen WKWebView, one PNG per state.
import AppKit
import WebKit

setvbuf(stdout, nil, _IONBF, 0)
let port = CommandLine.arguments[1]
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let input = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[3].utf8)) as! [String: Any]
let layout = input["layout"] as! [String: Any]
let panel = layout["window"] as! [String: Double]
let states = input["states"] as! [[String: Any]]
let cropHeight = 300.0

func json(_ value: Any) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
}

final class Loader: NSObject, WKNavigationDelegate {
  var ready: (() -> Void)?
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready?() }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: panel["width"]!, height: panel["height"]!), styleMask: [.borderless], backing: .buffered, defer: false)
let view = WKWebView(frame: window.contentView!.bounds)
window.contentView!.addSubview(view)
window.orderBack(nil)
let loader = Loader()
view.navigationDelegate = loader

// A painted menu bar and camera, under the page, through the CSSOM because its CSP refuses a
// style tag. Only here: the panel itself is transparent. Transitions go too: an offscreen window
// never ticks them, and every shot would be their first frame.
let backdrop = """
  (() => {
    const sheet = document.styleSheets[0];
    sheet.insertRule('#island, #pill2, #compact, #sheet { transition: none !important; }');
    document.documentElement.style.background = '#4a5680';
    const paint = (id, css) => { const el = document.createElement('div'); el.id = id; el.style.cssText = css; document.body.prepend(el); };
    paint('bar', 'position:fixed;left:0;right:0;top:0;height:37px;background:rgb(255 255 255 / .16)');
    paint('cam', 'position:fixed;top:14px;left:50%;width:9px;height:9px;margin-left:-4px;border-radius:50%;background:#26303f;z-index:10');
  })()
  """

func shoot(_ index: Int) {
  guard index < states.count else { NSApp.terminate(nil); return }
  let state = states[index]
  let housing = state["housing"] as! [String: Double]
  let expanded = state["expanded"] as? Bool ?? false
  let floating = housing["width"]! == 0
  let script = """
    document.getElementById('bar').style.height = \(floating ? "'25px'" : "'37px'");
    document.getElementById('cam').style.display = \(floating ? "'none'" : "'block'");
    window.__notch.render({ layout: \(json(layout)), housing: \(json(housing)), model: null });
    window.__notch.setExpanded(false);
    window.__notch.render({ layout: \(json(layout)), housing: \(json(housing)), model: \(json(state["model"]!)) });
    window.__notch.setExpanded(\(expanded));
    0
    """
  view.evaluateJavaScript(script) { _, error in
    if let error { print("render failed:", error) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
      let configuration = WKSnapshotConfiguration()
      configuration.rect = CGRect(x: 0, y: 0, width: panel["width"]!, height: cropHeight)
      view.takeSnapshot(with: configuration) { image, error in
        guard let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
          print("snapshot failed:", error ?? "no image"); exit(1)
        }
        try! png.write(to: output.appendingPathComponent("\(state["name"]!).png"))
        print("wrote", state["name"]!)
        shoot(index + 1)
      }
    }
  }
}

func whenDrawable(_ then: @escaping () -> Void) {
  view.evaluateJavaScript("typeof window.__notch") { answer, _ in
    if answer as? String == "object" { then() } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { whenDrawable(then) }
    }
  }
}

loader.ready = {
  loader.ready = nil
  whenDrawable { view.evaluateJavaScript(backdrop) { _, _ in shoot(0) } }
}
view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/notch/index.html")!))
application.run()
