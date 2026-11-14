/**
 * Where people get the Cezar app (spec 2026-11-01-relay-qr-pairing). The one place the store links
 * live; Settings > Connect a phone and the sidebar read them from here.
 */
export const MOBILE_APP = {
  /** One link for every phone: the relay sends iPhones to the App Store and everything else to Google Play. */
  downloadUrl: 'https://rome.cezar.run/app',
  googlePlay: 'https://play.google.com/store/apps/details?id=com.openmercato.cezar.mobile',
  // TODO(release): no App Store id exists yet (bundle id com.openmercato.cezar.mobile). Once the app is
  // listed, link https://apps.apple.com/app/id<APP_STORE_ID> here.
  appStore: 'https://rome.cezar.run/app',
  /** The release flips this when both stores list the app; until then Settings says to ask for a test build. */
  inStores: false,
} as const
