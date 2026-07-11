// Fixed-window per-IP rate limiter, shared by all api/ functions.
// Uses Upstash Redis (REST, no SDK) when UPSTASH_REDIS_REST_URL/TOKEN are set,
// so limits hold across serverless instances. Falls back to a per-instance
// in-memory window otherwise — best-effort, but better than nothing and fine
// for local dev. Fails open on Redis errors: availability over strictness.

const memoryWindows = new Map();

function memoryCheck(key, limit, windowSeconds) {
  const now = Date.now();
  const entry = memoryWindows.get(key);
  if (!entry || now - entry.start >= windowSeconds * 1000) {
    memoryWindows.set(key, { start: now, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  return { allowed: entry.count <= limit };
}

async function upstashCheck(key, limit, windowSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const response = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(windowSeconds), "NX"],
    ]),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Upstash ${response.status}`);
  const [{ result: count }] = await response.json();
  return { allowed: Number(count) <= limit };
}

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Returns { allowed: boolean }. `name` namespaces the counter per endpoint.
 */
export async function rateLimit(req, { name, limit, windowSeconds }) {
  const key = `rl:${name}:${clientIp(req)}`;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      return await upstashCheck(key, limit, windowSeconds);
    } catch {
      return { allowed: true }; // fail open — don't take the app down with Redis
    }
  }
  return memoryCheck(key, limit, windowSeconds);
}
