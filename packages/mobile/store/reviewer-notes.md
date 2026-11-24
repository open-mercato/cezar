# Reviewer notes

What App Review (Apple) and Play review need to use the app without our help. The demo cezar is set up
by `packages/mobile/demo/` on branch `demo/store-review` (README there). Before pasting, replace
`XXXX-XXXX-XXXX` with the code `setup.sh` printed. The code is not a password, but keep it out of public
metadata (description, screenshots, What's New).

## App Store Connect: App Review Information

- **Sign-in required:** unchecked. There is no account to sign in to; the notes give a pairing code.
- **Contact information:** a person who can answer within a day during review.
- **Notes:** the text below.

## Play Console: App content > App access

- **All or some functionality in my app is restricted** > **Add instructions**
- **Name:** `Demo pairing code`. **Username:** leave empty. **Password:** leave empty.
- **Any other information:** the text below.

## The notes text

<!-- reviewer-notes -->
```text
WHAT THE APP IS
cezar is a free, open-source tool that developers run on their own computer to supervise AI coding
agents. CezarBot is its phone companion: once paired with the user's own cezar, it shows that
cezar's Manager and tasks, so the user can answer agents' questions, approve actions and get a
notification when an agent needs them. CezarBot does nothing on its own until it is paired.

HOW IT CONNECTS
On their computer the user opens cezar, Settings, Connect a phone, and scans the QR code or types
the short code into CezarBot. The phone and the computer then talk through a small relay we run.
Everything is end-to-end encrypted (Noise protocol) between the phone and the user's computer; the
relay passes encrypted data and cannot read it. Advanced users can instead enter the address of a
cezar they host on their own server.

DEMO ACCESS (no sign-in needed)
We run a demo cezar for review, available at any time. Its projects are samples and its agents are
simulated: nothing you do runs a real AI model or changes real code, and every agent reply says so.
It resets every night at 03:00 UTC.

1. Open CezarBot and tap "Enter code".
2. Type this code:  XXXX-XXXX-XXXX
   and tap Connect. Pairing finishes on its own; nobody needs to approve it.
3. Accept the relay terms once. The app opens the demo's Manager.

Things to try
- Manager: answer the question card, and approve the "Add job" card.
- Tasks: open "Write a short CONTRIBUTING.md" and answer the agent's question; open a finished task
  to see its (simulated) pull request.
- Notifications: turn them on when the app asks (or in More > Notifications), then send the Manager
  "Start a task to add dark mode". About 20 seconds later the new task asks you a question and the
  phone gets a "cezar needs you" notification.
- Several demo reviewers can pair at once. If "Enter code" ever says the code was not found, wait
  one minute and try again: the demo reopens the code continuously.

Camera: used only to scan the pairing QR code on a user's own computer, decoded on the device, never
stored or sent. Notifications: optional, off until turned on; generic text and a badge count only.
The text in the Manager is written by the user's own coding agents about the user's own code.
```
<!-- /reviewer-notes -->
