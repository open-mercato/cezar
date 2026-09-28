import qrcode from 'qrcode-generator';
import { isLoopbackHost } from '../server/capabilities.ts';

/**
 * Renders `text` as a QR code a human can scan straight off the terminal, two
 * module rows per text line (upper half block / lower half block / full block),
 * with a two-module quiet zone. No dependency beyond the encoder: the caller
 * prints the returned lines.
 */
export function qrLines(text: string): string[] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;
  const dark = (row: number, col: number): boolean =>
    row >= quiet &&
    col >= quiet &&
    row < quiet + count &&
    col < quiet + count &&
    qr.isDark(row - quiet, col - quiet);
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = row + 1 < size ? dark(row + 1, col) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Which URL the startup banner should turn into a QR code, if any.
 *
 * `CEZ_PUBLIC_URL` wins when set (the operator knows the address the phone
 * should use — a tailnet name, a proxy URL); otherwise a non-loopback
 * `--bind-host` is addressable on its own. A loopback cockpit gets no QR: the
 * local browser is already one click away.
 */
/**
 * A11: the target is printed to the terminal and encoded into the QR frame, so
 * it must never carry credentials or a query token. An operator pasting
 * `https://user:pass@host/` would otherwise put a password into the scrollback
 * and into a picture; `?token=…` gets the same treatment because the spec
 * promises the URL is the only thing ever printed, never a token. Both are
 * stripped from the target itself, and `cockpitAccessWarnings` names the strip.
 * A value that will not parse as a URL is returned untouched — it cannot carry
 * a parsed credential, and the trust warning already names it.
 */
function sanitizePublicUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/** True when the raw value carries something the banner must not print. */
function publicUrlCarriesSecrets(raw: string): boolean {
  try {
    const url = new URL(raw);
    return Boolean(url.username || url.password || url.search || url.hash);
  } catch {
    return false;
  }
}

export function qrTargetUrl(opts: {
  publicUrl?: string | undefined;
  bindHost?: string | undefined;
  port: number;
}): string | null {
  const publicUrl = opts.publicUrl?.trim();
  if (publicUrl) return sanitizePublicUrl(publicUrl);
  const bind = opts.bindHost?.trim();
  if (!bind) return null;
  const unwrapped = bind.replace(/^\[|\]$/g, '');
  // One definition of loopback, shared with the server: LOCALHOST, 127/8 and
  // every spelling of ::1 all mean the local browser is one click away.
  if (isLoopbackHost(unwrapped) || isLoopbackHost(`[${unwrapped}]`)) return null;
  // The unspecified addresses name no host another device can reach.
  if (unwrapped === '0.0.0.0' || unwrapped === '::') return null;
  const host = unwrapped.includes(':') ? `[${unwrapped}]` : unwrapped;
  const target = `http://${host}:${opts.port}`;
  try {
    new URL(target);
  } catch {
    return null;
  }
  return target;
}

/**
 * Prints the QR (and its URL) when a target exists and the operator has not
 * silenced it (`CEZ_NO_QR=1`, or any CI). A TTY is required only when the
 * target was inferred from `--bind-host`: an explicitly set `CEZ_PUBLIC_URL`
 * is an instruction to show it, so the QR also lands in a captured log or a
 * `--no-open` run. Returns the target it printed, or `null`.
 */
export function printCockpitQr(opts: {
  publicUrl?: string | undefined;
  bindHost?: string | undefined;
  port: number;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  log?: (line: string) => void;
}): string | null {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  // Defaulted here, not at the call site: the first cut had the CLI forget to
  // pass it, which made the whole feature dead code with green tests.
  const tty = opts.tty ?? Boolean(process.stdout.isTTY);
  const target = qrTargetUrl(opts);
  if (!target) return null;
  const explicit = Boolean(opts.publicUrl?.trim());
  if (!explicit && !tty) return null;
  if (env.CEZ_NO_QR === '1' || env.CI) return null;
  log('');
  log(`  phone → ${target}`);
  try {
    for (const line of qrLines(target)) log(`  ${line}`);
  } catch (err) {
    // The encoder refuses payloads it cannot fit (~2.3 KB). That must never take
    // the cockpit down — the URL line above is already the useful half.
    log(`  (QR skipped: ${err instanceof Error ? err.message : String(err)})`);
  }
  log('');
  return target;
}

/**
 * Boot warnings for the two ways the private-front story can be misconfigured.
 * Both are printed by the banner, never silently ignored: a QR that lands on
 * the guard's 403, and a trusted authority whose reach the operator may not
 * have priced in (local handoff stays on).
 */
export function cockpitAccessWarnings(opts: {
  publicUrl?: string | undefined;
  trusted: Set<string>;
  hosted: boolean;
}): string[] {
  const out: string[] = [];
  if (opts.hosted) return out;
  const publicUrl = opts.publicUrl?.trim();
  if (publicUrl) {
    const printed = sanitizePublicUrl(publicUrl);
    if (publicUrlCarriesSecrets(publicUrl)) {
      out.push(
        'CEZ_PUBLIC_URL carries credentials or a query string — they are stripped from the printed URL and the QR',
      );
    }
    let authority = '';
    let host = '';
    try {
      const parsed = new URL(printed);
      authority = parsed.host.toLowerCase();
      host = parsed.hostname.replace(/^\[|\]$/g, '');
    } catch {
      authority = '';
    }
    const loopbackTarget = host !== '' && (isLoopbackHost(host) || isLoopbackHost(`[${host}]`));
    if (!loopbackTarget && (!authority || !opts.trusted.has(authority))) {
      out.push(`CEZ_PUBLIC_URL (${printed}) is not in CEZ_TRUSTED_HOSTS — a scan would hit the #426 host guard`);
    }
  }
  if (opts.trusted.size > 0) {
    out.push(
      `CEZ_TRUSTED_HOSTS is on: ${[...opts.trusted].join(', ')} also reaches agent-config editing, home-wide fs browse, the launch key and Origin-less writes/WS — keep it on a private network, never a public front`,
    );
  }
  return out;
}

/**
 * The whole private-front banner block, in one call: the trusted-hosts line,
 * the QR (with its target), and the warnings. Extracted so the *wiring* is
 * unit-tested — the first cut shipped a dead feature because the call site,
 * not the function, was the untested part.
 */
export function printPrivateFrontBanner(opts: {
  publicUrl?: string | undefined;
  bindHost?: string | undefined;
  port: number;
  trusted: Set<string>;
  hosted: boolean;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  log?: (line: string) => void;
}): { printedQr: string | null; warnings: string[] } {
  const log = opts.log ?? console.log;
  const emit = (line: string) => log(line);
  if (opts.trusted.size > 0) emit(`  trusted hosts (CEZ_TRUSTED_HOSTS) → ${[...opts.trusted].join(', ')}\n`);
  const printedQr = printCockpitQr({
    publicUrl: opts.publicUrl,
    bindHost: opts.bindHost,
    port: opts.port,
    env: opts.env,
    tty: opts.tty,
    log: emit,
  });
  const warnings = cockpitAccessWarnings({ publicUrl: opts.publicUrl, trusted: opts.trusted, hosted: opts.hosted });
  for (const warning of warnings) emit(`  ⚠ ${warning}\n`);
  return { printedQr, warnings };
}
