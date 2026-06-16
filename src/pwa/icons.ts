import { ICON_FILES } from './icon-files';

/** A Web App Manifest icon entry. Structurally a subset of the manifest spec. */
export interface AppIcon {
  readonly src: string; // absolute URL, e.g. '/pwa-192x192.png'
  readonly sizes: string; // 'WxH', e.g. '512x512'
  readonly type: string; // MIME, e.g. 'image/png'
  readonly purpose?: 'any' | 'maskable';
}

const BASE = import.meta.env.BASE_URL; // '/' by default (design.md §6.5)

/** The three manifest icons (also used by the VitePWA manifest via the build copy). */
export const MANIFEST_ICONS: ReadonlyArray<AppIcon> = [
  { src: `${BASE}${ICON_FILES.pwa192}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: `${BASE}${ICON_FILES.pwa512}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: `${BASE}${ICON_FILES.maskable512}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** MediaSession lock-screen artwork (D-018). NO maskable variant — lock-screen art is
 *  not masked. Passed to transport via createTransport({ artwork: APP_ICONS }).
 *  Resolves the registry stub "MediaSession artwork default uses pwa-shell app icons". */
export const APP_ICONS: ReadonlyArray<MediaImage> = [
  { src: `${BASE}${ICON_FILES.pwa192}`, sizes: '192x192', type: 'image/png' },
  { src: `${BASE}${ICON_FILES.pwa512}`, sizes: '512x512', type: 'image/png' },
];
