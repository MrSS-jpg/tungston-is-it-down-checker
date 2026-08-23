// api/check.js
// This runs on Vercel's server, NOT in the browser.
// The GROQ_API_KEY only ever lives here, as an environment variable.
// The browser never sees it.

const dns = require("dns").promises;

// ---------- very small in-memory rate limiter ----------
// Note: on Vercel each serverless instance has its own memory, and cold
// starts wipe it. This stops a single abusive burst from one instance,
// it is NOT a substitute for a real rate limiter (see README for the
// Upstash/Vercel Firewall note if you want to harden this further).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const requestLog = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// ---------- SSRF protection ----------
// Without this, someone could ask your server to "check" http://169.254.169.254
// or http://localhost:6379 and use YOUR server to probe internal/cloud
// metadata services. We block that at two layers: hostname text, and the
// actual resolved IP address (to stop DNS-rebinding tricks).

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

  // Resolve DNS ourselves and check the actual IP, so someone can't hide
  // a private IP behind a public-looking domain name.
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

// ---------- the actual reachability check ----------
async function checkReachability(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const start = Date.now();

  try {
    // Try a lightweight HEAD request first.
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });

    // Some servers reject HEAD (405/501) - fall back to GET.
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }

    return {
      reachable: response.ok || (response.status >= 200 && response.status < 400),
      statusCode: response.status,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      reachable: false,
      statusCode: null,
      latencyMs: Date.now() - start,
      error: err.name === "AbortError" ? "Timed out after 8 seconds" : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- ask Groq for a one-line, human summary ----------
async function getAiSummary(url, result) {
  if (!process.env.GROQ_API_KEY) {
    return null; // Feature degrades gracefully if the key isn't set yet.
  }

  const prompt = `A website reachability check just ran.
URL: ${url}
Reachable: ${result.reachable}
HTTP status code: ${result.statusCode ?? "none"}
Latency: ${result.latencyMs}ms
Error (if any): ${result.error ?? "none"}

Write ONE short, friendly sentence (max 25 words) telling the user what this means in plain English. No markdown, no preamble.`;

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
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null; // Never let an AI summary failure break the core feature.
  }
}

module.exports = async (req, res) => {
  // ---- security headers on every response ----
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const rawUrl = (body && body.url ? String(body.url) : "").trim();
  if (!rawUrl) {
    res.status(400).json({ error: "Please provide a url." });
    return;
  }

  // Normalize: if someone types "example.com" without a scheme, assume https.
  const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  let safeUrl;
  try {
    safeUrl = await assertUrlIsSafe(candidate);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  const result = await checkReachability(safeUrl.toString());
  const aiSummary = await getAiSummary(safeUrl.toString(), result);

  res.status(200).json({
    url: safeUrl.toString(),
    ...result,
    aiSummary,
  });
};
