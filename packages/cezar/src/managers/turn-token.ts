/**
 * The per-turn token (spec 2026-11-20-manager-admin-actions § 3.1). The engine mints one per manager
 * turn and puts it in the turn's env; `cez manager` sends it on every request; the server's tool
 * routes require it and the cockpit's own writes refuse it. Not a fence against a process that drops
 * the header (a free shell can call any loopback route, spec § 3.7): it keeps the manager's own CLI
 * off the cockpit's routes and tells the server which turn is asking.
 */
export const MANAGER_TURN_HEADER = 'x-cez-manager-turn';
export const MANAGER_TURN_ENV = 'CEZ_MANAGER_TURN_TOKEN';
export const MANAGER_TURN_REQUIRED = 'only a running manager turn may call this: `cez manager` works inside one';
export const MANAGER_TURN_REFUSED = "a manager turn cannot call this: it is the cockpit's, for the user";
