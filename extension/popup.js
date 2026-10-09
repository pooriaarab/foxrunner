// The demo popup: lists tasks with their steps, and sends pause, resume and
// cancel to the event page.
const MARK = { pending: "○", running: "◐", sleeping: "☾", waiting: "?", done: "●", failed: "✕" };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function wakeText(task) {
  if (!task.runAt || task.status !== "queued") return "";
  const s = Math.max(0, Math.round((task.runAt - Date.now()) / 1000));
  return `next step in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stepMeta(step) {
  const parts = [step.status];
  if (step.attempt > 1) parts.push(`attempt ${step.attempt}`);
  if (step.failures) parts.push(`${step.failures} failed`);
  return parts.join(", ");
}

function button(label, type, id) {
  return el("button", { type: "button", textContent: label, onclick: () => send({ type, id }) });
}

function render(tasks) {
  const list = document.getElementById("tasks");
  list.replaceChildren(
    ...tasks.map((task) => {
      const actions = el("div", { className: "actions" });
      if (["queued", "running", "waiting"].includes(task.status)) actions.append(button("Pause", "pause", task.id));
      if (task.status === "paused") actions.append(button("Resume", "resume", task.id));
      if (!["done", "failed", "cancelled"].includes(task.status)) actions.append(button("Cancel", "cancel", task.id));
      return el(
        "li",
        {},
        el("div", { className: "top" }, el("strong", { textContent: task.name }), el("span", { className: "id", textContent: task.id.slice(0, 8) }), el("span", { className: `badge ${task.status}`, textContent: task.status })),
        el("ul", { className: "steps" }, ...task.steps.map((s) => el("li", {}, el("span", { textContent: MARK[s.status] ?? "·" }), el("span", { className: "name", textContent: s.name }), el("span", { className: "meta", textContent: stepMeta(s) })))),
        el("div", { className: "meta", textContent: wakeText(task) }),
        task.error ? el("div", { className: "error", textContent: task.error }) : "",
        actions,
      );
    }),
  );
}

async function send(msg) {
  await browser.runtime.sendMessage(msg);
  await refresh();
}

async function refresh() {
  render((await browser.runtime.sendMessage({ type: "list" })) ?? []);
}

document.getElementById("start").addEventListener("click", () => send({ type: "start", input: {} }));
browser.storage.onChanged.addListener(() => void refresh());
setInterval(() => void refresh(), 1000);
void refresh();
