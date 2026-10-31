// Keep the tail of a virtualized transcript in the DOM. Flat threads stay as rendered.
window.app ??= {};
app.thread = {
  mount(el) {
    if (el.dataset.virtualized !== "true") return;
    const trim = () => {
      const size = Number(el.dataset.window) || 16;
      const rows = [...el.children].filter((node) => node.tagName === "LI");
      if (rows.length <= size) return;
      el.replaceChildren(...rows.slice(rows.length - size));
    };
    trim();
    if (el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    new MutationObserver(trim).observe(el, { childList: true });
  },
};
