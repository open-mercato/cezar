// Render every mermaid fence. The bundle is static/js/mermaid.min.js (no CDN).
window.app ??= {};
app.diagram = {
  render(el) {
    if (!(el instanceof Element) || el.querySelector("svg")) return;
    const source = el.textContent || "";
    if (!source.trim() || typeof mermaid === "undefined") return;
    const id = "d" + Math.random().toString(36).slice(2);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      fontFamily: "sans-serif",
    });
    mermaid
      .render(id, source)
      .then(({ svg }) => {
        el.innerHTML = svg;
      })
      .catch(() => {
        el.dataset.error = "mermaid";
      });
  },
};
