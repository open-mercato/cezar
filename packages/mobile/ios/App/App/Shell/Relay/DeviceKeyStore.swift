import Foundation
import Security

/// Device keys by server id. A protocol so the flows can be tested without a keychain.
protocol DeviceKeyStore: AnyObject {
    /// Throws when it cannot save: pairing then ends as `internal` rather than with a crash (Java throws too).
    func put(_ id: String, _ keys: DeviceKeys) throws
    /// Nil when absent or unreadable: a lost key reads as a phone that must pair again.
    func get(_ id: String) -> DeviceKeys?
    func delete(_ id: String)
}

/// iOS Keychain, this device only, while unlocked (spec Decision 2): never in a backup, never synced.
final class KeychainDeviceKeyStore: DeviceKeyStore {
    struct SaveFailed: Error {
        let status: OSStatus
    }

    static let service = "com.openmercato.cezar.mobile.relaykey"

    private func query(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: id,
         kSecUseDataProtectionKeychain as String: true]
    }

    func put(_ id: String, _ keys: DeviceKeys) throws {
        guard Self.safe(id) else { throw SaveFailed(status: errSecParam) }
        SecItemDelete(query(id) as CFDictionary)
        var item = query(id)
        item[kSecValueData as String] = Data(keys.toBytes())
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw SaveFailed(status: status) }
    }

    func get(_ id: String) -> DeviceKeys? {
        guard Self.safe(id) else { return nil }
        var search = query(id)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return DeviceKeys.fromBytes([UInt8](data))
    }

    func delete(_ id: String) {
        guard Self.safe(id) else { return }
        SecItemDelete(query(id) as CFDictionary)
    }

    /// Ids are UUIDs; anything else is a bug, never a key name.
    static func safe(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" }
    }
}
