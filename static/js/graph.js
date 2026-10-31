window.app ??= {};
app.graph = {
  down(el, evt) {
    el.dataset.px = String(evt.clientX);
    el.dataset.py = String(evt.clientY);
  },
  drop(el, evt) {
    const dx = evt.clientX - Number(el.dataset.px || evt.clientX);
    const dy = evt.clientY - Number(el.dataset.py || evt.clientY);
    const x = Math.max(0, Math.round(Number(el.dataset.x) + dx));
    const y = Math.max(0, Math.round(Number(el.dataset.y) + dy));
    const idInput = document.querySelector("#move-id");
    const xInput = document.querySelector("#move-x");
    const yInput = document.querySelector("#move-y");
    if (!idInput || !xInput || !yInput) return;
    idInput.value = el.dataset.id;
    xInput.value = String(x);
    yInput.value = String(y);
    for (const input of [idInput, xInput, yInput]) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  },
};
