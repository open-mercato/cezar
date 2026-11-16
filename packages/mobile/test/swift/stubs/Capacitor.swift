// A STUB of the Capacitor 8.6 iOS API, only what the adapters call, with signatures copied from
// node_modules/@capacitor/ios. scripts/typecheck-ios.sh builds it as module `Capacitor` so the adapters
// typecheck. It proves names and types match this copy, not that they match the real framework.
import UIKit
import WebKit

public typealias PluginCallResultData = [String: Any]
public let CAPPluginReturnPromise = "promise"
public let CAPPluginReturnNone = "none"

public protocol InstanceConfiguration { var serverURL: URL { get } }

public protocol CAPBridgeProtocol: AnyObject {
    var viewController: UIViewController? { get }
    var config: InstanceConfiguration { get }
    var webView: WKWebView? { get }
    func registerPluginInstance(_ pluginInstance: CAPPlugin)
}

open class CAPPluginCall: NSObject {
    public var keepAlive = false
    public func getString(_ key: String) -> String? { nil }
    public func getString(_ key: String, _ defaultValue: String) -> String { defaultValue }
    public func getBool(_ key: String) -> Bool? { nil }
    public func getBool(_ key: String, _ defaultValue: Bool) -> Bool { defaultValue }
    public func getInt(_ key: String) -> Int? { nil }
    public func getInt(_ key: String, _ defaultValue: Int) -> Int { defaultValue }
    public func resolve(_ data: PluginCallResultData = [:]) {}
    public func reject(_ message: String, _ code: String? = nil, _ error: Error? = nil, _ data: PluginCallResultData? = nil) {}
}

public class CAPPluginMethod: NSObject {
    public init(name: String, returnType: String) {}
}

public protocol CAPBridgedPlugin: AnyObject {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}

open class CAPPlugin: NSObject {
    public weak var webView: WKWebView?
    public weak var bridge: CAPBridgeProtocol?
    public override init() {}
    open func load() {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?) {}
}

open class CAPBridgeViewController: UIViewController {
    public var bridge: CAPBridgeProtocol? { nil }
    public var webView: WKWebView? { nil }
    open func capacitorDidLoad() {}
}

public class SceneDelegateProxy: NSObject, UISceneDelegate {
    public static let shared = SceneDelegateProxy()
    public func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {}
    public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {}
    public func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {}
}

public class ApplicationDelegateProxy: NSObject, UIApplicationDelegate {
    public static let shared = ApplicationDelegateProxy()
    public func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool { false }
}
