// Cross-origin guard for the API functions. Browsers attach an Origin header
// to cross-site POSTs; if it doesn't match the host serving this function,
// some other site is spending our quota — reject it. Requests without an
// Origin (same-origin navigations, curl, server-to-server) pass through:
// this blocks drive-by browser abuse, not determined attackers — the rate
// limiter handles volume.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.headers["x-forwarded-host"] || req.headers.host || "";
    return originHost === requestHost;
  } catch {
    return false;
  }
}
