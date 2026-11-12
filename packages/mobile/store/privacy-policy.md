# Cezar mobile app privacy policy

Effective date: [OPEN MERCATO TO CONFIRM: effective date]

Who this policy is from: [OPEN MERCATO TO CONFIRM: legal entity name, registered address and data
controller, if any]. Contact: [OPEN MERCATO TO CONFIRM: privacy contact address].

## What this policy covers

This policy covers the Cezar mobile app, the relay that connects the app to a computer, and push
notifications.

The app is available for Android. An iOS version is not released yet, and this policy does not describe
it. Before an iOS release this policy has to be checked again.

The app is a small shell. It shows the Cezar cockpit from a Cezar server that you run or that someone
runs for you. It connects in one of two ways:

- **Through the relay**, after you pair the phone with Cezar on your computer.
- **Directly**, when you enter the HTTPS address of a server that is reachable on the internet.

## The short version

- You do not create an account with the app.
- The app contains no analytics, advertising or crash-reporting code, and sends no telemetry of its own.
- Your work, such as tasks, code and messages, is encrypted end to end between the phone and your
  computer when you use the relay. The relay cannot read it.
- The relay can still see some connection details, such as IP addresses, timing and data volume.
  These are listed below.
- Notifications are optional and off until you turn them on for a server. A notification says only
  "Cezar needs you". It never carries your tasks, code or messages.

## What stays on your phone

The app keeps the following in its private storage. Android's backup and device transfer are turned
off for this app, so this data is not copied to your cloud backup or to a new phone.

| Data | Why | How it is kept |
| --- | --- | --- |
| Your server list: name, address, and for direct servers the username and login realm | To reconnect | Plain JSON in app-private storage |
| For paired servers: relay address, Cezar's public identifiers and key, the phone's ID on that server, a local port number | To reconnect through the relay | Plain JSON in app-private storage |
| Your server password, if you saved one | To sign in to a direct server | Encrypted with a key in the Android Keystore that cannot be exported |
| The phone's private keys for each paired server | To prove the phone is yours and to encrypt the connection | Encrypted with the same Keystore key |
| Whether the phone lock is on | To apply the lock | An empty file. It holds no secret |
| Cookies, page storage and the browser cache of the server's pages | So the cockpit works | Android WebView's normal storage for this app |

**Removing a server.** When you forget a server, the app deletes its saved password or keys and its
entry in the list. It also clears the page storage for that server, and most cookies of a direct
server. Cookies set for a wider domain or a sub-path, and cookies from a single sign-on provider, can stay. It does not clear the WebView's HTTP cache, or cookies for a paired server, so these can stay on
the phone until you clear the app's storage or uninstall the app.

**Phone lock.** The optional lock is off by default. It uses Android's own prompt for your biometrics
or screen lock. The app never receives your fingerprint, face data or PIN. It only learns whether the
prompt succeeded. The lock hides the app, but it does not change how keys are stored. With the lock
on, the app's preview is hidden on the recent apps screen, although the app itself stays listed there.
On Android 12 and older this also blocks screenshots of the app.

## Permissions

| Permission | Why |
| --- | --- |
| Internet | To reach the relay, your server, and images a cockpit page shows from other sites |
| Camera | Only to scan the pairing QR code, when you choose to. The app reads the code on the phone and does not save or send the images |
| Biometrics (`USE_BIOMETRIC`, `USE_FINGERPRINT`) | Only for the optional phone lock. These come from the Android biometric library |
| Notifications (`POST_NOTIFICATIONS`) | Asked for on Android 13 and newer, only when you turn notifications on for a server |
| Receive push messages, keep the phone awake briefly, see whether the network is up (`c2dm.permission.RECEIVE`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE`) | Added by Firebase Cloud Messaging, so a notification can arrive while the app is closed. Unused until you turn notifications on |

If a cockpit page offers a file upload, Android's file picker opens. Only the file you pick is sent, and
it goes to your Cezar server.

The app asks for no location, contacts, microphone or advertising ID access.

## What Cezar on your computer keeps about your phone

This data is on your own computer, in `~/.cezar/relay/devices.json`, and is readable only by your
user account. It does not reach us through this mechanism.

- The phone's name, taken from the phone's model name, which you can rename
- The platform (`android`)
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
on when the app asks after your first pairing, or with the **Notifications** switch on the server list.
Android 13 and newer then asks for the notification permission.

**While the app is open**, or for 30 seconds after you leave it, the app asks your Cezar for signals
inside the encrypted connection and shows a notification itself. Nothing leaves the encrypted
connection for this.

**While the app is closed**, a notification comes through Firebase Cloud Messaging (Google):

- When you turn notifications on, the app gets a push token from Firebase and sends it to the relay.
  The relay seals the token into a grant that only your Cezar can use, and returns the grant without
  storing the token. The app hands the grant to your Cezar inside the encrypted connection.
- When Cezar needs you and the phone is not connected, Cezar asks the relay to send a push. The
  notification carries the fixed text "Cezar needs you" and Cezar's ID, and nothing about your tasks,
  projects or messages. Google sees that notification, the token and the time.
- The relay keeps a revoked grant's ID for up to 90 days, so it cannot be reused, and refuses a
  repeated push ID for 10 minutes.
- Turning the switch off revokes the grant at the relay at once. Forgetting the server revokes it too.
- The app does not ask Firebase for anything until a switch is on, and it turns off Firebase
  analytics.

[OPEN MERCATO TO CONFIRM: whether the released build includes Firebase (`google-services.json`). Without
it, notifications arrive only while the app is open, and the Firebase paragraphs above do not apply.]

## Your choices

- Forget a server in the app, or remove a phone on your computer. Either one stops the connection.
- Turn the phone lock on or off.
- Uninstalling the app removes its data from the phone.
- Deny the camera permission and pair by typing a code instead.
- Turn notifications off for a server, or deny the notification permission.

Records on the relay contain no name or email. They hold keys and IDs. To ask about your data:
[OPEN MERCATO TO CONFIRM: how to make a request, which rights apply, response time, supervisory
authority].

## Other terms

- Children: [OPEN MERCATO TO CONFIRM: children's clause and minimum age]
- International transfers: [OPEN MERCATO TO CONFIRM: transfer basis and countries, given Cloudflare]
- Changes to this policy: [OPEN MERCATO TO CONFIRM: how changes are announced]
- Governing law: [OPEN MERCATO TO CONFIRM: jurisdiction]

---
