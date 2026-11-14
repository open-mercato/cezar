# Reviewer notes

What App Review (Apple) and Play review need to use the app without our help. The demo server is set up
by `packages/mobile/demo/` (README there). Before pasting, replace `cezar-demo.example.com` with the demo's
`DEMO_DOMAIN` and `<password>` with its `DEMO_PASSWORD`. Keep the password out of this repository.

## App Store Connect: App Review Information

- **Sign-in required:** checked
- **User name:** `appreview`
- **Password:** `<password>`
- **Contact information:** a person who can answer within a day during review.
- **Notes:** the text below.

## Play Console: App content > App access

- **All or some functionality in my app is restricted** > **Add instructions**
- **Name:** `Demo server`. **Username:** `appreview`. **Password:** `<password>`
- **Any other information:** the text below. Play has no URL field, so the address must be in it.

## The notes text

Delete the "Optional: pairing" part if the build has no relay client (iOS until #1901's iOS half
lands) or the demo runs with `DEMO_RELAY=0`.

<!-- reviewer-notes -->
```text
WHAT THE APP IS
cezar is a free, open-source tool that people run on their own computer or server to supervise AI
coding agents. This app is its companion: it connects to the user's own cezar and shows that
server's Manager and tasks, sized for a phone. The app has no account system and no server of ours
that holds user data.

HOW IT CONNECTS
1. Pairing through a relay (the default). On their computer the user opens cezar, Settings, Connect
   a phone, and scans the QR code or types the short code. The phone and the computer then talk
   through a small relay we run. Everything is end-to-end encrypted with the Noise protocol between
   the phone and the user's computer; the relay passes encrypted data and cannot read it.
2. Direct. A user whose cezar runs on a server with HTTPS enters its address and signs in. The
   password is kept in the device's secure storage and answered natively, never by the web page.

Native features: QR pairing with the camera, the encrypted relay connection, keychain sign-in,
several servers, notifications when cezar needs the user, and an optional app lock with biometrics.

DEMO ACCESS
We run a demo cezar for review. Its agents are simulated: nothing you do runs a real AI model or
changes real code, and it resets every night at 03:00 UTC.

1. Open the app. On "Connect to cezar", enter the server address (if the screen shows "Scan QR
   code" and "Enter code", open "Advanced" first):
   https://cezar-demo.example.com
2. Tap Connect. When asked, enter the user name and password from the sign-in fields above.
3. The app opens the Manager. Tasks are in the menu: open "Write a short CONTRIBUTING.md" to answer
   an agent's question, or start a new task.

Optional: pairing the way users do, without a password
1. In any browser, on a computer or on this phone, open
   https://cezar-demo.example.com/demo-pair/ and sign in with the same user name and password.
2. Tap "Show a code". In the app, choose "Enter code" and type the 12-character code within two
   minutes.
3. When the app shows a number, check that the page shows the same number, then tap Approve on the
   page. The demo allows 5 codes per hour; if the page says so, use the steps above.

Camera: used only to scan the pairing QR code, decoded on the device, never stored or sent.
Notifications: optional, off until turned on per server; they say only "Cezar needs you".
The text in the Manager is written by the user's own coding agents about the user's own code.
```
<!-- /reviewer-notes -->
