import { QrSvg } from '@/components/qr-svg'
import { MOBILE_APP } from '@/lib/mobile-app'

/**
 * Plain styled links, not the official badges: the stores' badge artwork comes with its own terms,
 * and these say the same thing.
 */
function StoreLink({ href, kicker, name }: { href: string; kicker: string; name: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-11 w-44 flex-col justify-center rounded-lg bg-foreground px-3.5 text-background transition-opacity hover:opacity-85 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="text-[10px] leading-tight opacity-80">{kicker}</span>
      <span className="text-sm leading-tight font-semibold">{name}</span>
    </a>
  )
}

/** Step 1 of Connect a phone: where the app comes from. The small QR is for the phone's own camera. */
export function GetTheApp() {
  return (
    <div className="space-y-3" data-testid="get-the-app">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex flex-col gap-2">
          <StoreLink href={MOBILE_APP.appStore} kicker="Download on the" name="App Store" />
          <StoreLink href={MOBILE_APP.googlePlay} kicker="Get it on" name="Google Play" />
        </div>
        <figure className="flex items-center gap-3">
          <QrSvg value={MOBILE_APP.downloadUrl} label="QR code that opens the Cezar app's store page" className="size-24 shrink-0" />
          <figcaption className="max-w-40 text-xs text-muted-foreground">Scan with your phone camera to get the app</figcaption>
        </figure>
      </div>
      {MOBILE_APP.inStores ? null : (
        <p className="text-xs text-muted-foreground" data-testid="test-build-note">Not in the stores yet? Ask your admin for a test build.</p>
      )}
    </div>
  )
}
