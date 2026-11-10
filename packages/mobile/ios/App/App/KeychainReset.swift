import Foundation
import Security

/// Keychain items outlive an uninstall on iOS; Android's no-backup files do not. The first launch of
/// an install deletes what a previous one left, so no device key or password survives a reinstall.
enum KeychainReset {
    private static let marker = "cezar.installed"

    static func afterReinstall(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: marker) else { return }
        for service in ["com.openmercato.cezar.mobile.server", KeychainDeviceKeyStore.service] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                           kSecUseDataProtectionKeychain as String: true] as CFDictionary)
        }
        defaults.set(true, forKey: marker)
    }
}
