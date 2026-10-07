// api/check.js
// Runs on Vercel's server. Protected with multi-layer SSRF validation,
// Edge/browser cache-control, in-memory deduplication, and Groq AI diagnosis.

const dns = require("dns").promises;

// ---------- rate limiter ----------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestLog = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (requestLog.size > 2000) {
    for (const [k, v] of requestLog.entries()) {
      const active = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (active.length) requestLog.set(k, active);
      else requestLog.delete(k);
    }
  }
  return false;
}

// ---------- 60s in-memory response cache ----------
// Prevents duplicate DNS queries and duplicate Groq AI invocations for frequent checks.
const CACHE_TTL_MS = 60_000;
const checkCache = new Map(); // urlString -> { data, timestamp }

function getCached(url) {
  const hit = checkCache.get(url);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return hit.data;
  }
  return null;
}

function setCached(url, data) {
  checkCache.set(url, { data, timestamp: Date.now() });
  if (checkCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of checkCache.entries()) {
      if (now - v.timestamp >= CACHE_TTL_MS) checkCache.delete(k);
    }
  }
}

// ---------- SSRF protection ----------
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

function isPrivateIp(ip) {
  // IPv4 private / reserved ranges
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  // IPv6 private / reserved ranges
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

async function assertUrlIsSafe(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// URLs are allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("That host isn't allowed.");
  }

  // Resolve DNS ourselves and check actual IP to prevent DNS rebinding tricks
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Couldn't resolve that hostname.");
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error("That host resolves to a private/internal address and isn't allowed.");
    }
  }

  return parsed;
}

// ---------- safe reachability check with redirect protection ----------
async function checkReachability(initialUrl) {
  let currentUrl = initialUrl;
  let hops = 0;
  const maxHops = 3;
  const start = Date.now();

  while (hops <= maxHops) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    try {
      // Use manual redirect to inspect each hop and prevent SSRF redirect bypass
      let response = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status === 405 || response.status === 501) {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      }

      clearTimeout(timeout);

      // Handle Redirect safely
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location && hops < maxHops) {
          const nextUrl = new URL(location, currentUrl).toString();
          // Validate redirect destination against SSRF!
          await assertUrlIsSafe(nextUrl);
          currentUrl = nextUrl;
          hops++;
          continue;
        }
      }

      return {
        reachable: response.ok || (response.status >= 200 && response.status < 400),
        statusCode: response.status,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      clearTimeout(timeout);
      return {
        reachable: false,
        statusCode: null,
        latencyMs: Date.now() - start,
        error: err.name === "AbortError" ? "Timed out after 7 seconds" : err.message,
      };
    }
  }

  return {
    reachable: false,
    statusCode: null,
    latencyMs: Date.now() - start,
    error: "Too many redirects.",
  };
}

// ---------- ask Groq for a one-line, human summary ----------
async function getAiSummary(url, result) {
  if (!process.env.GROQ_API_KEY) {
    return null;
  }

  const prompt = `A website reachability check just ran.
URL: ${url}
Reachable: ${result.reachable}
HTTP status code: ${result.statusCode ?? "none"}
Latency: ${result.latencyMs}ms
Error (if any): ${result.error ?? "none"}

Write ONE short, friendly sentence (max 25 words) telling the user what this means in plain English. No markdown, no preamble.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

module.exports = async (req, res) => {
  // ---- security headers on every response ----
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
  }

  let rawUrl = "";
  if (req.method === "GET") {
    rawUrl = (req.query?.url ? String(req.query.url) : "").trim();
  } else {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    rawUrl = (body && body.url ? String(body.url) : "").trim();
  }

  if (!rawUrl) {
    return res.status(400).json({ error: "Please provide a url." });
  }

  // Normalize: if someone types "example.com" without a scheme, assume https.
  const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  let safeUrl;
  try {
    safeUrl = await assertUrlIsSafe(candidate);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const urlKey = safeUrl.toString();

  // Return cached result if checked within the last 60s
  const cached = getCached(urlKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached);
  }

  const result = await checkReachability(urlKey);
  const aiSummary = await getAiSummary(urlKey, result);

  const payload = {
    url: urlKey,
    ...result,
    aiSummary,
  };

  setCached(urlKey, payload);
  res.setHeader("X-Cache", "MISS");
  return res.status(200).json(payload);
};
