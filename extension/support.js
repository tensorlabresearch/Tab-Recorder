const BTC_ADDRESS = "3C8MP16nhPVEAPecFZ7tudSjDXkg2zVYEB";

const copyBtn = document.getElementById("copy-btn");
const walletBtn = document.getElementById("wallet-btn");
const toastEl = document.getElementById("toast");

copyBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(BTC_ADDRESS);
    showToast("Address copied to clipboard", "success");
  } catch (_) {
    showToast("Unable to copy address", "error");
  }
});

walletBtn?.addEventListener("click", () => {
  window.open(`bitcoin:${BTC_ADDRESS}`, "_blank");
});

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3000);
}
