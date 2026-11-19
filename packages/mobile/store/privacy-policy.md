# CezarBot privacy policy

Published privacy policy: [Open Mercato privacy policy](https://openmercatocloud.com/privacy).
This repository document is an internal technical draft covering iOS and Android, not the published
legal text. Unconfirmed facts below remain unresolved; do not publish this draft as a replacement.

Effective date: [OPEN MERCATO TO CONFIRM: effective date]

Who this policy is from: [OPEN MERCATO TO CONFIRM: legal entity name, registered address and data
controller, if any]. Contact: [OPEN MERCATO TO CONFIRM: privacy contact address].

## What this policy covers

This policy covers CezarBot, the Cezar mobile app (called "the app" below), the relay that connects the app to a computer, and push
notifications.

This policy describes the iOS and Android apps. Platform-specific storage, permissions and
notification delivery are explained below.

The app is a small shell. It shows the Cezar cockpit from a Cezar server that you run or that someone
runs for you. It connects in one of two ways:

- **Through the relay**, after you pair the phone with Cezar on your computer.
- **Directly**, when you enter the HTTPS address of a server that is reachable on the internet.

## The short version

- You do not create an account in the app. The relay asks whoever runs Cezar on a computer for an
  email address and to accept its terms, once per computer, in Cezar's Settings. The phone never asks
  for it.
- The app contains no analytics, advertising or crash-reporting code, and sends no telemetry of its own.
- Your work, such as tasks, code and messages, is encrypted end to end between the phone and your
  computer when you use the relay. The relay cannot read it.
- The relay can still see some connection details, such as IP addresses, timing and data volume.
  These are listed below.
- Notifications are optional and off until you turn them on for a server. The relay sends the fixed
  text "Cezar needs you", a computer identifier and a badge count. The phone can add the computer's
  saved name locally. Your tasks, code and messages are never included in the remote push payload.

## What stays on your phone

The app keeps the following in its private storage. Android's backup and device transfer are turned
off for this app. On iOS, the app excludes its saved-server directory, relay bundle cache and push
state directory from backups. Passwords and pairing keys use device-only Keychain items, rather than
iCloud Keychain sync. This does not promise that all WebKit or system-managed data is excluded from
an iOS backup.

| Data | Why | How it is kept |
| --- | --- | --- |
| Your device list: name, address, and for direct servers the username and login realm | To reconnect | Plain JSON in app-private storage |
| For paired servers: relay address, Cezar's public identifiers and key, the phone's ID on that server, a local port number | To reconnect through the relay | Plain JSON in app-private storage |
| Your server password, if you saved one | To sign in to a direct server | Android: encrypted with a non-exportable Android Keystore key. iOS: device-only Keychain, readable while the phone is unlocked |
| The phone's private keys for each paired server | To prove the phone is yours and to encrypt the connection | Android: encrypted with the same Keystore key. iOS: device-only Keychain, readable while unlocked, with sync disabled |
| Whether the phone lock is on | To apply the lock | An empty file. It holds no secret |
| Cookies, page storage and the browser cache of the server's pages | So the cockpit works | Android: this app's WebView storage. iOS: a separate persistent WebKit data store for each saved server |
| Cached cockpit scripts and styles for relay servers | To open the cockpit faster | App-private files, excluded from backups; no API responses are cached by this bundle cache |
| Notification switches, sealed grants and pending revocations | To deliver optional notifications and revoke permission | App-private JSON; iOS excludes the push directory from backups |
| Saved computer names, identifiers and last-known badge counts | To name notifications locally and add up the app badge | iOS: a device-only Keychain item shared with the app's notification extension, accessible after the first unlock |
| A digest of the last APNs token | To detect a changed token | iOS app preferences; the APNs token itself is held in memory |
| Recent connection diagnostics | To help you troubleshoot a connection | App-private log, capped at 300 lines of startup steps, timings and connection states; Android can also record the relay hostname. The Devices screen lets you copy it yourself |

**Removing a server.** Forgetting a server removes its saved entry, password and cached cockpit bundle.
If a push grant still needs revoking, the app keeps the pairing key and a pending revocation record
until the revocation is settled or the grant expires; it retries when the app runs again.

On Android, the app clears the server's page storage and most cookies of a direct server. Cookies
set for a wider domain or a sub-path, and cookies from a single sign-on provider, can stay. It does
not clear the WebView's HTTP cache or a paired server's cookies, so those can stay until you clear
the app's storage or uninstall it.

On iOS, the app wipes that server's WebKit data, including cookies, page storage and cache, and
requests deletion of its separate data store. If WebKit cannot remove the store immediately, the
app retries at the next launch. iOS Keychain items can survive uninstalling an app; CezarBot clears
its old saved passwords and pairing keys on the first launch after reinstalling. Do not rely on an
uninstall alone to erase Keychain data, including the shared notification names and badge counts.

**Phone lock.** The optional lock is off by default. Android uses its own biometric or screen-lock
prompt; iOS uses Face ID, Touch ID or the device passcode. The app never receives your fingerprint,
face data or PIN. It only learns whether the prompt succeeded. The lock hides the app, but does not
change how keys are stored. With the lock on, the app's preview is covered in the app switcher.
On Android 12 and older this also blocks screenshots of the app. The iOS lock does not prevent
screenshots while you use the unlocked app.

## Permissions

| Permission | Why |
| --- | --- |
| Internet (Android manifest permission; network access on iOS) | To reach the relay, your server, and images a cockpit page shows from other sites |
| Camera (both platforms) | Only to scan the pairing QR code, when you choose to. The app reads the code on the phone and does not save or send the images |
| Biometrics (`USE_BIOMETRIC`, `USE_FINGERPRINT` on Android; Face ID permission on iOS) | Only for the optional phone lock |
| Notifications (`POST_NOTIFICATIONS` on Android 13 and newer; notification authorization on iOS) | Asked for when you turn notifications on for a server |
| Receive push messages, keep the phone awake briefly, see whether the network is up (`c2dm.permission.RECEIVE`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE`, Android only) | Added by Firebase Cloud Messaging in builds that include it, so a notification can arrive while the app is closed |

If a cockpit page offers a file upload, Android's file picker opens. Only the file you pick is sent, and
it goes to your Cezar server.

The app asks for no location, contacts, microphone or advertising ID access.

## What Cezar on your computer keeps about your phone

This data is on your own computer, in `~/.cezar/relay/devices.json`, and is readable only by your
user account. It does not reach us through this mechanism.

- The phone's name, taken from the phone's model name, which you can rename
- The platform (`android` or `ios`)
- The phone's public keys and its device ID
- When it was added and when it was last seen
- Push grant IDs, if you turned notifications on

You can remove a phone in Cezar's Settings. Cezar deletes the entry and tells the relay to remove the
phone. If you forget a server in the app while Cezar is reachable, the entry is deleted as well.
Otherwise it stays until you remove it on the computer. The phone's ID stays in the file until the relay
confirms the removal.

## What the relay does

The relay passes encrypted data between your phone and your computer. Nothing reaches the relay until
you click **Test** or **Connect a phone** in Cezar on your computer. Your computer keeps a connection
to the relay only while a phone is paired or a removal is still waiting to reach the relay.

The app's default relay is `https://rome.cezar.run`. If you set a different
relay address, whoever runs that relay is responsible for it, and this section does not apply to them.

**What the relay cannot see.** Requests, responses, your code, tasks, messages, files and passwords.
These are encrypted with the Noise protocol between your phone and your computer, and the relay never
has the keys. It also never sees the pairing QR code.

**What the relay can see while it works:**

- Your IP address and your computer's IP address
- The public keys and identifiers used to connect: Cezar's ID, the phone's device ID and, during
  pairing, a one-time locator and the public keys in the handshake
- When each side connects and disconnects, and whether the other side is online
- How much data passes and when. Messages are padded to multiples of 256 bytes, which hides exact
  sizes but not overall volume
- How many phones are connected to a computer

**What the relay stores:**

| Data | How long |
| --- | --- |
| Cezar's ID, when it was last connected, and the list of paired phones (device ID and public key, at most 10) | Until the phone is removed, or until the relay's daily cleanup deletes the record 90 days after Cezar was last seen |
| Daily and hourly usage counters for abuse limits: data volume, phone connection time, pairing and push counts | Overwritten each period, deleted with the record above |
| Cezar's ID and the last-seen day, in an index used by the cleanup | Until the cleanup deletes the record |
| A salted hash of your IP address, used only for rate limits | The stored limit is removed after one hour |
| Pairing state | Not stored. It ends when both sides disconnect, within five minutes at most |

The relay does not store your IP address in plain form, or keep any message it forwards. It holds no
undelivered messages. The relay's code writes no logs, and Cloudflare's Workers logging is off in its
configuration. It reports usage data points with no ID in them: time awake, phone-connected
time and the number of wake-ups. Each point covers one stretch of activity, not a total.

## The relay account (email)

Since 2026-11-13 the relay asks each computer that uses it for an email address and for acceptance of
the terms and privacy policy. You give them in Cezar on your computer, in **Settings > Connect a phone**,
before the first pairing, or once when Cezar first starts after the update if phones are already
paired. The app itself never asks for your email.

**Why.** The relay is a service run by Open Mercato. Its terms and privacy obligations require a record
of who accepted the terms and a way to reach them. The email is used only to confirm that the address
is yours, to send notices about the relay (such as changes to the terms, security issues or the end of
the service), and to handle a deletion request. It is not used for marketing. [OPEN MERCATO TO CONFIRM:
lawful basis for the account data, and that it is never used for marketing]

**What the relay stores for the account:**

| Data | Why | How long |
| --- | --- | --- |
| Your email address, trimmed and in lower case | To confirm it and to reach you | Until you delete the account. An address that is never confirmed is deleted 30 days after it was given |
| The terms version you accepted and when, and when the address was confirmed | Proof of acceptance | As long as the account |
| Which computers (Cezar IDs) use the account, and when each was attached and confirmed | Confirmation is per computer, so nobody can borrow an account by knowing its address | As long as the account. A computer whose account is deleted keeps only its ID and the start of its grace period, until 90 days after that grace ended |
| The device IDs of the phones paired with each computer | To know which phones the account covers | Replaced each time a phone is paired or removed, deleted with the account |
| One-time link tokens for confirmation and deletion | To check a link you follow | Stored only as keyed hashes. They expire after 15 minutes and are deleted by the daily cleanup |
| Counters for sending and attempt limits, keyed by hashes of the email address and IP address | To stop abuse | Deleted after 2 hours |

**Emails.** The relay sends one plain email per request, leading with a confirmation link, with a paragraph on
why we ask. The email has no tracking pixel or tracked links. The link opens a relay page that asks for one
button press, so a mail scanner that follows links cannot confirm or delete anything. [OPEN MERCATO TO
CONFIRM: the email sending provider, which is Cloudflare Email Sending in the relay's configuration]

**If the email is not confirmed.** Phones keep working for 48 hours after the computer first gives an
email, or after the computer was first seen by the relay. After that the relay refuses to connect that
computer's phones until the email is confirmed. Opening the link in the email reconnects them. Cezar's
Settings and the phone's **Confirm your email** screen can only check the status and send a new link. No
phone has to pair again.

**What the phone sees.** When the relay refuses a phone for this reason, the app asks the relay for
the account's status, signed with the phone's key. The relay sends the address masked, such as
`p***@gmail.com`, so a lost or shared phone does not reveal it, and the app shows it that way so you
know where the link went. You can ask for a new link from the app; opening it and pressing the button confirms. The app takes no code and does not store the address.

**Deleting the account.** In Cezar on your computer, open **Settings > Connect a phone** and choose
**Delete account**, or enter the address on the relay's own page at `https://rome.cezar.run/account/delete`,
which answers the same whether or not an account exists. The relay emails a link, and following it deletes the email address, the account's
list of phones and its codes, and detaches every computer from it. Deleting the account does not
restart the 48-hour grace, so phones stop connecting until an email is given again.

A hashed IP address can still count as personal data, because someone holding the salt could test
guesses against it. [OPEN MERCATO TO CONFIRM: how this is classified, and the lawful basis for the
relay's processing]

## Third parties

- **Cloudflare** runs the relay, using Workers and Durable Objects. Because Cloudflare carries the
  traffic, it handles the connection details above, including IP addresses. What Cloudflare itself
  keeps is set by its own terms, not by the relay's code. [OPEN MERCATO TO CONFIRM: Cloudflare account
  holder, data processing agreement, regions, Cloudflare's retention]
- **Google**, through Firebase Cloud Messaging, only if you turn notifications on and the build
  includes Firebase. It receives the push token and each notification described under Notifications.
- **Apple**, through Apple Push Notification service (APNs) on iOS. The app registers with APNs at
  launch, before notifications are enabled. Registering does not enable alerts or hand a token to the
  relay; that happens only after you enable notifications. Apple then delivers remote notifications
  as described below. The iOS app does not use Firebase.
- **The Cezar server you connect to.** It receives everything you do in the cockpit. If you run it,
  that is you. If someone else runs it, their own terms apply.
- **The coding agents your Cezar runs** are chosen and configured by you on your computer. The app does
  not process that data and does not contact those services.
- **Hosts of images shown in the cockpit.** Cockpit pages can show images stored elsewhere: GitHub
  profile pictures, images inside issue, pull request and tracker text, images in your agents' messages,
  and a project picture set by its address. Your phone loads each one directly from its host, so that
  host can see your phone's IP address and the time. The relay does not hide this. Whoever wrote the
  text chooses the host, and that can be someone you do not know.
- **Your phone's browser.** Links that lead away from your server open in your browser, which has its
  own policy. A direct server that uses single sign-on shows that provider's login page in the app.

We do not sell data. The app contains no advertising. [OPEN MERCATO TO CONFIRM: the "we do not sell"
statement as a company commitment]

## Telemetry

The app sends no telemetry and has no analytics or crash-reporting library. The relay's code sends none
either, apart from the usage data points above.

The cockpit inside the app can report usage to Cezar on your computer. Your Cezar forwards it to Open
Mercato only if you opted in. That is Cezar's own opt-in telemetry, described in Cezar's telemetry
documentation. An answer to that question given on the phone is saved as your Cezar's answer.

## Notifications

Notifications are off until you turn them on for a server paired through the relay. You can turn them
on when the app asks after your first pairing, or with the **Notifications** switch on the Devices list.
Android 13 and newer and iOS then ask for notification permission.

**While the app is open**, the app asks your Cezar for signals inside the encrypted connection and
shows a notification itself. It attempts to keep this connection for up to 30 seconds after you leave;
the operating system can suspend it sooner. This does not require a remote push through Apple or Google.

**While the app is closed**, remote delivery uses APNs (Apple) on iOS, or Firebase Cloud Messaging
(Google) on Android if Firebase is included in the build and the relay is configured to deliver it:

- On iOS the app registers with APNs at launch and holds the token in memory; it stores only a digest
  to detect token changes. On Android it asks Firebase for a token only after a notification switch
  is on. Once you enable notifications, the app sends the token to the relay. The relay seals it into
  a grant that only your Cezar can use, and returns the grant without storing the token. The app hands
  the grant to your Cezar inside the encrypted connection.
- When Cezar needs you and the phone is not connected, Cezar asks the relay to send a push. The
  notification carries the fixed text "Cezar needs you", Cezar's ID and a badge count from 0 to 99,
  and nothing about your task titles, code, projects or messages. Apple or Google sees this payload,
  the token and the delivery time. The phone can replace the generic title with the saved computer
  name and combine badge counts locally; the saved name is not part of the remote push payload.
- The relay keeps a revoked grant's ID for up to 90 days, so it cannot be reused, and refuses a
  repeated push ID for 10 minutes.
- Turning the switch off or forgetting the server requests revocation at the relay. If it cannot
  complete, the app keeps the pending revocation and retries; it does not promise immediate remote
  revocation while offline.
- The Android app does not ask Firebase for anything until a switch is on, and it turns off Firebase
  analytics. iOS uses APNs and contains no Firebase SDK.

[OPEN MERCATO TO CONFIRM: whether the released build includes Firebase (`google-services.json`). Without
it, Android has no closed-app push delivery. Confirm that the production relay is configured for APNs
and, if used, FCM, and that delivery has been verified on the store builds.]

## Your choices

- Forget a server in the app, or remove a phone on your computer. Either one stops the connection.
- Turn the phone lock on or off.
- Uninstalling the app removes its app-private files. On iOS, Keychain cleanup occurs on the next
  installation's first launch, as described above.
- Deny the camera permission and pair by typing a code instead.
- Turn notifications off for a server, or deny the notification permission.
- Change or delete the relay account's email in Cezar's Settings, under Connect a phone.

The relay holds keys and IDs, the relay account's email address and acceptance records, and may receive
your computer's saved name for confirmation emails. You can delete the account from Cezar's Settings.
To ask about your data:
[OPEN MERCATO TO CONFIRM: how to make a request, which rights apply, response time, supervisory
authority].

## Other terms

- Children: [OPEN MERCATO TO CONFIRM: children's clause and minimum age]
- International transfers: [OPEN MERCATO TO CONFIRM: transfer basis and countries, given Cloudflare]
- Changes to this policy: [OPEN MERCATO TO CONFIRM: how changes are announced]
- Governing law: [OPEN MERCATO TO CONFIRM: jurisdiction]

---
