// Tungston Is It Down Checker ── Client Controller

const form = document.getElementById("check-form");
const input = document.getElementById("url-input");
const btn = document.getElementById("check-btn");
const initialSpec = document.getElementById("initial-spec");
const resultOutput = document.getElementById("result-output");
const resultCode = document.getElementById("result-code");
const resultStatus = document.getElementById("result-status");
const themeToggle = document.getElementById("theme-toggle");

// ---------- Theme Management (Dark Mode Default) ----------
function initTheme() {
  const saved = localStorage.getItem("tungston_theme") || "dark";
  if (saved === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    themeToggle.textContent = "🌙 DARK";
  } else {
    document.documentElement.removeAttribute("data-theme");
    themeToggle.textContent = "☀️ LIGHT";
  }
}

themeToggle.addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("tungston_theme", "dark");
    themeToggle.textContent = "☀️ LIGHT";
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("tungston_theme", "light");
    themeToggle.textContent = "🌙 DARK";
  }
});

initTheme();

// ---------- Escape HTML Helper ----------
function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Probe Form Submission ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const rawUrl = input.value.trim();
  if (!rawUrl) return;

  btn.disabled = true;
  btn.textContent = "PROBING...";
  resultCode.textContent = "PING-02";
  resultStatus.textContent = "CONNECTING...";

  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: rawUrl }),
    });

    const data = await res.json();

    if (!res.ok) {
      renderError(data.error || "Probe failed to execute.");
      return;
    }

    renderResult(data);
  } catch (err) {
    renderError("Network error: Could not reach the probe service.");
  } finally {
    btn.disabled = false;
    btn.textContent = "PROBE ↗";
  }
});

// ---------- Render Successful Check Result ----------
function renderResult(data) {
  const isUp = data.reachable;

  resultCode.textContent = isUp ? "OK-200" : "ERR-HOST";
  resultStatus.textContent = isUp ? "ONLINE" : "UNREACHABLE";

  initialSpec.classList.add("hidden");
  resultOutput.classList.remove("hidden");

  resultOutput.innerHTML = `
    <div class="result-banner ${isUp ? "is-up" : "is-down"}">
      <div class="banner-left">
        <span class="dot ${isUp ? "online" : "offline"}"></span>
        <span class="banner-title">${isUp ? "SYSTEM OPERATIONAL" : "HOST UNREACHABLE"}</span>
      </div>
      <span class="banner-code">${data.statusCode ? "HTTP " + data.statusCode : (isUp ? "HTTP 200" : "CONN FAIL")}</span>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">RESOLVED TARGET</div>
        <div class="metric-value">${escapeHtml(data.url)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">LATENCY</div>
        <div class="metric-value">${data.latencyMs} ms</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">HTTP STATUS</div>
        <div class="metric-value">${data.statusCode ? "STATUS " + data.statusCode : (isUp ? "200 OK" : "NO RESPONSE")}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">STATE</div>
        <div class="metric-value" style="color: ${isUp ? "var(--up)" : "var(--down)"}">${isUp ? "REACHABLE" : "DOWN / BLOCKED"}</div>
      </div>
    </div>

    ${data.error ? `
      <div class="ai-box" style="border-left-color: var(--down);">
        <div class="ai-box__label" style="color: var(--down);">ERROR DIAGNOSTIC</div>
        <div class="ai-box__text">${escapeHtml(data.error)}</div>
      </div>
    ` : ""}

    ${data.aiSummary ? `
      <div class="ai-box">
        <div class="ai-box__label">GROQ AI VERDICT</div>
        <div class="ai-box__text">${escapeHtml(data.aiSummary)}</div>
      </div>
    ` : ""}
  `;
}

// ---------- Render Error Result ----------
function renderError(message) {
  resultCode.textContent = "ERR-400";
  resultStatus.textContent = "PROBE BLOCKED";

  initialSpec.classList.add("hidden");
  resultOutput.classList.remove("hidden");

  resultOutput.innerHTML = `
    <div class="result-banner is-down">
      <div class="banner-left">
        <span class="dot offline"></span>
        <span class="banner-title">PROBE REJECTED</span>
      </div>
      <span class="banner-code">HALTED</span>
    </div>
    <div class="ai-box" style="border-left-color: var(--down);">
      <div class="ai-box__label" style="color: var(--down);">REASON</div>
      <div class="ai-box__text">${escapeHtml(message)}</div>
    </div>
  `;
}
