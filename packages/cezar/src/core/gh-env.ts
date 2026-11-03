/**
 * The environment every `gh` call of this program runs with.
 *
 * On Linux, `gh` keeps its token in the system keyring when it can and reads it through D-Bus.
 * With no session bus address in the environment, its D-Bus library (go-keyring, cli/cli#7582)
 * has `dbus-launch` start a bus for the call — a `dbus-daemon` that nothing ever stops. The
 * cockpit runs `gh auth token` every five minutes in the backend probe, so a container that ran
 * for two days held 532 of them. Each holds one of the user's inotify instances, the kernel caps
 * those at 128 per uid, and from then on no file watcher of that user could start: the app
 * preview's `vite` logged "EMFILE: too many open files" for every file it tried to watch.
 *
 * A cockpit with no session bus of its own cannot reach a keyring through a bus started on the
 * spot either, so nothing is lost by refusing the start: the bus address is set to a socket
 * nobody listens on, `gh` fails to connect at once and falls back to its config file, as it does
 * on a server. A shell that has a real session bus keeps it — the variable is only filled in when
 * it is absent — and it is read at each call, so a bus that appears later is used.
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== 'linux' || base.DBUS_SESSION_BUS_ADDRESS) return base;
  return { ...base, DBUS_SESSION_BUS_ADDRESS: GH_NO_SESSION_BUS };
}

/** A bus address nothing listens on: connecting fails at once, and nothing is launched. */
export const GH_NO_SESSION_BUS = 'unix:path=/nonexistent';
