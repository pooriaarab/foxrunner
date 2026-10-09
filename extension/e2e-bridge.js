// For the E2E test only: it runs on 127.0.0.1 pages. It passes commands from
// the page to the event page, and copies foxrunner's stored state into the
// page. It reads storage directly, so it does not keep the event page loaded.
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.data?.frn !== "command") return;
  const result = await browser.runtime.sendMessage(event.data.msg);
  window.postMessage({ frn: "reply", id: event.data.id, result }, "*");
});

setInterval(async () => {
  const all = await browser.storage.local.get(null);
  const tasks = Object.entries(all)
    .filter(([key]) => key.startsWith("frn:task:"))
    .map(([, task]) => task);
  const ledger = all["demo:ledger"] ?? {};
  document.documentElement.dataset.frnState = JSON.stringify({ tasks, boots: all["demo:boots"] ?? [], ledger });
}, 250);
