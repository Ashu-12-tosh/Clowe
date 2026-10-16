// Security headers that do not change per request (next.config.mjs sends them
// on every page). Plain JS so next.config can import it at build time.

/**
 * What the pages may use. The camera is for the seller's packing video
 * (recorded in the browser on the order page) and the microphone for voice
 * search, both from our own origin only; nothing uses location or the
 * Topics API.
 */
export const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), geolocation=(), browsing-topics=()';
