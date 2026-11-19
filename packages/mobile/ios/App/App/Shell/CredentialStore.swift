import Foundation
import Security

/// Passwords by server id. A protocol so the flows can be tested without a keychain.
protocol CredentialStore {
    func put(_ id: String, password: String)
    func get(_ id: String) -> String?
    func delete(_ id: String)
}

/// iOS Keychain, this device only, while unlocked (spec Decision 2).
struct KeychainCredentialStore: CredentialStore {
    private static let service = "com.openmercato.cezar.mobile.server"

    private func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: id]
    }

    func put(_ id: String, password: String) {
        delete(id)
        var item = query(id)
        item[kSecValueData as String] = Data(password.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    /// Nil when absent or unreadable: a lost item reads as "no password saved", which re-asks.
    func get(_ id: String) -> String? {
        var search = query(id)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func delete(_ id: String) {
        SecItemDelete(query(id) as CFDictionary)
    }
}
