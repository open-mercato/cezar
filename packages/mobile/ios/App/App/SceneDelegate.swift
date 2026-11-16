import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // A plain launcher start only: a tap or a link may open another server. The splash stays up while
        // it decides, so a server opens straight from it (LaunchHold); the lock must open nothing first.
        if connectionOptions.notificationResponse == nil && connectionOptions.urlContexts.isEmpty && connectionOptions.userActivities.isEmpty
            && !AppLock.shared.enabled {
            LaunchHold.shared.start()
            ShellServices.prewarm()
        }
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ShellViewController()
        window?.makeKeyAndVisible()
        // The optional lock covers the window, the app switcher's snapshot included (spec QR3).
        if let window { AppLock.shared.install(on: window) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
