// app.js
// Bootstraps the document, initial render, and default tool on load.
//
// Kept deliberately minimal — this is the one file that should always be
// readable in a glance. Any real logic belongs in document.js/canvas.js/
// tools.js/panels.js/export.js, not here.

try {
  doc = newDocument();
  renderDoc();
  renderLayers();
  setTool("select");

  // Project list fetch is async and already handles its own errors
  // internally (export.js's refreshProjectList catches + flashes status) —
  // intentionally not awaited here so first paint isn't gated on network.
  refreshProjectList();

  document.body.dataset.appReady = "true";
} catch (err) {
  console.error("inkkit failed to start:", err);
  document.body.innerHTML =
    `<div style="padding:2rem;font:14px system-ui,sans-serif;color:#9a9894">
       inkkit couldn't start — check the console for details.
     </div>`;
}