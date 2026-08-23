const form = document.getElementById("check-form");
const input = document.getElementById("url-input");
const btn = document.getElementById("check-btn");
const resultBox = document.getElementById("result");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  btn.disabled = true;
  btn.textContent = "Checking...";
  resultBox.classList.add("hidden");

  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      renderError(data.error || "Something went wrong.");
      return;
    }

    renderResult(data);
  } catch (err) {
    renderError("Couldn't reach the checker service. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Check";
  }
});

function renderResult(data) {
  const isUp = data.reachable;
  resultBox.innerHTML = `
    <div class="status-line ${isUp ? "status-up" : "status-down"}">
      ${isUp ? "It's up ✅" : "It looks down ❌"}
    </div>
    <div class="meta">
      ${data.url}<br/>
      ${data.statusCode ? `HTTP ${data.statusCode} · ` : ""}${data.latencyMs}ms
      ${data.error ? `<br/>${data.error}` : ""}
    </div>
    ${data.aiSummary ? `<div class="ai-summary">${escapeHtml(data.aiSummary)}</div>` : ""}
  `;
  resultBox.classList.remove("hidden");
}

function renderError(message) {
  resultBox.innerHTML = `<div class="status-line status-down">Error</div><div class="meta">${escapeHtml(message)}</div>`;
  resultBox.classList.remove("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
