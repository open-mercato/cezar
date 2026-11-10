import UIKit
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    /// Strong: the notification center keeps its delegate weakly.
    private var receiver: PushReceiver?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        KeychainReset.afterReinstall()
        // Before any server view exists, so no store is still in use (spec M2 item 9).
        Task { @MainActor in await WebsiteData.removeOwed() }
        // Before returning, so a tap that cold-launched the app is delivered (APNs and Stage 1 alike).
        let receiver = PushReceiver(servers: { ShellServices.connector.list() }, enabled: { ShellServices.push.enabled($0) }) {
            DispatchQueue.main.async { Self.shell()?.reopenForTap() }
        }
        self.receiver = receiver
        UNUserNotificationCenter.current().delegate = receiver
        // Without an aps-environment entitlement this fails, and push stays off: Stage 1 still works.
        ApnsTokenSource.shared.onTokenChanged = {
            DispatchQueue.global(qos: .utility).async { ShellServices.push.onNewToken(ShellServices.connector.list()) }
        }
        ApnsTokenSource.shared.register(application)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        ApnsTokenSource.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        ApnsTokenSource.shared.didFailToRegister()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        ShellServices.notifier.refresh()
        ShellServices.notifier.clearBadge()
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    private static func shell() -> ShellViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).compactMap { $0.rootViewController as? ShellViewController }.first
    }
}
