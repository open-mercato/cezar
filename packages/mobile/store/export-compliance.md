# CezarBot 0.1.1: proposed export answers

Prepared 2026-11-16 for PR #2261, native-source inventory at `05934ef62`.
The user chose **worldwide except France**. This records a launch plan, not an applied App Store
availability setting or permission to submit a declaration. The final signed archive, publisher
identity/country and any existing app-specific filings have not been verified.

## Recommendation and its limits

Use the **published standard-encryption** route for the reviewed implementation. Disclose the
app-owned Noise protocol rather than relying on an OS-only interpretation. No proprietary or
unpublished cryptographic function was identified. That is a reasoned technical recommendation,
not an assigned ECCN or an approval from Apple/BIS.

For this route, Apple lists no encryption-document upload when France is excluded. Accordingly,
the recommended release plist declaration is Boolean **`ITSAppUsesNonExemptEncryption = false`**
after publisher sign-off and final-build/availability verification. Apple's documentation ties
this value to exemption from encryption-documentation requirements, not absence of encryption.
Do not add an export-compliance approval code without one actually issued by Apple. The plist is
deliberately unchanged by this documentation update; a declaration needs separate approval.

Sources: [Apple documentation table](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption),
[plist submission guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations),
[key definition](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption).

If the final product has unpublished crypto, additional SDKs or restricted/private components,
reassess first. `true` is appropriate only if the approved determination identifies non-exempt
encryption; it is not required merely because the app encrypts content. Until sign-off, leaving
the key absent preserves Apple's questionnaire rather than asserting an unapproved answer.

## Proposed App Store Connect answers

These map the question meanings; no authenticated live questionnaire was inspected. They are
instructions for a later authorized submission, not answers already entered. An exemption from
Apple document uploads is separate from the US EAR jurisdiction/classification below.

| Question meaning | Answer for the proposed release |
| --- | --- |
| Uses, accesses, contains or implements encryption | **Yes** |
| Encryption limited to HTTPS | **No** |
| Encryption limited to authentication/digital signatures | **No** |
| Proprietary/unpublished or non-standard cryptographic functionality | **No**, on the reviewed public implementation; verify final archive |
| Standard algorithms outside or in addition to Apple's OS encryption | **Yes / select the standard-algorithms option** for the app-owned Noise/HKDF composition; do not claim OS-only |
| Both standard and proprietary algorithms | **No** |
| Available on the App Store in France | **No**, once an authorized operator has actually excluded France; the plan alone does not establish the live setting |
| Requires an Apple encryption-document upload for that standard/no-France route | **No** |
| `ITSAppUsesNonExemptEncryption` | **false**, after sign-off; currently absent |

If a prompt asks for a specific Category 5 exclusion, do not answer it using the document-upload
row. Use the approved US rationale below; do not manufacture a banking, medical, authentication-only
or HTTPS-only exemption. Retain the actual questionnaire outcome. If Apple treats the protocol
differently, stop and resolve that specific discrepancy before submission.

## Verified engineering evidence

Paths below are relative to `packages/mobile/ios/App/` unless stated otherwise.

| Function and purpose | Source evidence and ownership |
| --- | --- |
| TLS for direct HTTPS and relay WSS | `App/Shell/Relay/URLSessionTransport.swift`, `RelayOrigin.swift`, `App/Shell/ServerOrigin.swift`: Apple URLSession/WebKit transport; release origins require HTTPS |
| End-to-end record encryption | `App/Shell/Relay/RelayCrypto.swift`: Apple CryptoKit ChaCha20-Poly1305, 256-bit keys; `TunnelSession.swift`/`NoiseCipher.swift` supply app counters and rekey/state |
| Session key agreement | `RelayCrypto.swift`: CryptoKit X25519; `NoiseHandshake.swift`: published Noise XXpsk3/KK, `25519_ChaChaPoly_SHA256`, implemented in Swift |
| Identity/request signatures | `RelayCrypto.swift`: CryptoKit Ed25519 |
| Hashing, derivation and pairing | `RelayCrypto.swift`: SHA-256/HMAC/HKDF via CryptoKit, PBKDF2-HMAC-SHA256 via CommonCrypto; `PairSecret.swift`: 200,000 PBKDF2 iterations; `NoiseHandshake.swift`: app-composed HKDF using HMAC calls |
| Randomness and stored secrets | `RelayCrypto.swift`: Security RNG; `CredentialStore.swift`/`Relay/DeviceKeyStore.swift`: device-only Keychain |
| Declared native dependencies | `CapApp-SPM/Package.swift`: Capacitor/Cordova; no third-party crypto library declared there |

[Primitive implementation](https://github.com/open-mercato/cezar/blob/05934ef62/packages/mobile/ios/App/App/Shell/Relay/RelayCrypto.swift),
[protocol/composition](https://github.com/open-mercato/cezar/blob/05934ef62/packages/mobile/ios/App/App/Shell/Relay/NoiseHandshake.swift),
[public MIT license](https://github.com/open-mercato/cezar/blob/05934ef62/LICENSE),
[published Noise specification](https://noiseprotocol.org/noise.html).
Published does not claim Noise is IETF-certified. The
[EAR definition of non-standard cryptography](https://www.bis.gov/regulations/ear/772) distinguishes
proprietary/unpublished functions; the reviewed implementation supports the proposed No answer.

## US determination and filing sequence

1. **Establish the actual release.** Record the publishing/exporting legal entity and country,
   app/version/build, archive hash, public source tag/commit, dependency inventory, distribution
   method and any existing Apple/BIS records. Check that the archive corresponds to the public
   source, with no private cryptographic additions. Public repository status alone does not prove
   that fact about a future IPA. Ordinary public App Store distribution is the working release
   assumption, not a new user-confirmed fact.
2. **Preferred route: publicly available encryption source and corresponding object code.**
   Have the responsible reviewer document applicability of EAR §§742.15(b), 734.3(b)(3),
   734.7(b) and 734.17(b). If their conditions cover this actual release, the result is
   **not subject to the EAR**, not EAR99 or a mass-market ECCN. No ENC classification/report is
   needed for items outside the EAR under that route. Current §742.15(b)(2)'s special source-code
   notification concerns non-standard cryptography; it is not a blanket email requirement for all
   published standard crypto. If non-standard functionality is found, review that notification and
   associated update rules before relying on the exclusion. No notification has been sent.
3. **Fallback if the public-source/object route does not apply:** evaluate the complete app against
   Category 5 Part 2 Note 3 and §740.17(b)(1), including public availability, self-installation,
   user modification of crypto, and the exclusions in (b)(2)/(b)(3). **5D992.c is the proposed
   mass-market candidate only after a supported self-classification or BIS classification.**
   CCATS is not automatically required for an ordinary eligible (b)(1) self-classification; if a
   mandatory-review category applies, use that procedure instead. No ECCN has been assigned here.
4. **Determine reporting from the actual route.** Current §740.17(e)(3) does not impose an annual
   self-classification report on every finished mass-market app: its scope includes specified
   encryption components/executables and non-mass-market items. Retain the rationale for whether
   this finished app falls outside that scope. If it does apply, prepare the Supplement 8 report
   for BIS and the ENC coordinator by **February 1 following the export year**. A CCATS-classified
   (b)(1) product does not require that self-classification report. Do not invent a registration,
   approval or filing receipt. Nothing has been filed by this task.

Sources: [EAR Part 734](https://www.bis.gov/regulations/ear/734),
[§742.15(b)](https://www.bis.gov/regulations/ear/742),
[§740.17](https://www.bis.gov/regulations/ear/740),
[BIS mass-market guidance](https://www.bis.gov/learn-support/encryption-controls/mass-market).
The responsible publisher must approve the route and retain its evidence. The proposed Apple
document exemption does not establish US jurisdiction, an ECCN or permission in every destination.

## Release checklist and remaining facts

- [x] Owner's intended markets recorded: worldwide except France (2026-11-16).
- [x] Technical inventory and proposed Apple answers prepared; privacy/provider coverage remains
      approved under the existing external Open Mercato policy, whose text is unchanged.
- [ ] Confirm publisher legal entity/country, public versus restricted distribution/private additions,
      and any existing app-specific Apple/BIS paperwork. These facts remain unanswered.
- [ ] Engineering verifies the signed archive/source correspondence and dependency inventory;
      responsible reviewer approves and records the US route/reporting rationale.
- [ ] Obtain explicit approval before submitting declarations, changing the plist export declaration
      or applying territory settings. Then retain the live no-France setting and questionnaire
      evidence. No French App Store declaration upload is expected for this plan under Apple's
      table; this is not a conclusion about every French supply/import scenario.
- [ ] Signing/TestFlight evidence and Store QA remain incomplete. Keep PR #2261 draft.

Adding France, changing crypto/dependencies or shipping a different private build requires a fresh
review. “Worldwide” means supported and lawfully available markets, not authorization to bypass
Apple's destination restrictions or applicable sanctions/import rules.
