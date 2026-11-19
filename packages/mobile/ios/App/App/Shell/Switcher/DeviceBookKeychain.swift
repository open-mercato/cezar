import Foundation
import Security

/// The book in a keychain access group the app and its Notification Service Extension share. A keychain
/// group needs no App Group registration, so automatic signing covers it. Unsigned builds (the simulator
/// with signing off) have no group: the item then stays the app's own and the extension finds nothing.
final class KeychainDeviceBookStorage: DeviceBookStorage {
    static let service = "com.openmercato.cezar.mobile.devices"
    private static let account = "book"

    private let group: String?

    /// `CezarKeychainGroup` in Info.plist: `$(AppIdentifierPrefix)…devices`, the entitlement's own value.
    init(bundle: Bundle = .main) {
        let group = bundle.object(forInfoDictionaryKey: "CezarKeychainGroup") as? String
        // Without a team the prefix is empty and the group cannot be the entitled one.
        self.group = group.flatMap { $0.hasPrefix(".") || !$0.contains(".") ? nil : $0 }
    }

    func read() -> Data? {
        var query = base(group)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess { return result as? Data }
        guard group != nil else { return nil }
        query = base(nil)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess ? result as? Data : nil
    }

    func write(_ data: Data) {
        if save(data, group) == errSecSuccess { return }
        // No entitlement for the group (an unsigned build): the app's own keychain still keeps the counts.
        if group != nil { _ = save(data, nil) }
    }

    private func save(_ data: Data, _ group: String?) -> OSStatus {
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base(group) as CFDictionary, update as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        var add = base(group)
        add[kSecValueData as String] = data
        // The extension runs while the phone is locked, after the first unlock.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil)
    }

    private func base(_ group: String?) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
                                    kSecAttrAccount as String: Self.account, kSecUseDataProtectionKeychain as String: true]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }
}
