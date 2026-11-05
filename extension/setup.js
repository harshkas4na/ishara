// Visible extension page: Chrome only shows the mic prompt for a page the user is looking at,
// and the grant is stored for the extension origin, which the offscreen recorder shares.
document.getElementById("b").onclick = async () => {
  const r = document.getElementById("r");
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    r.textContent = "Microphone allowed. You can close this tab.";
  } catch (e) {
    r.textContent = "Not allowed (" + e.name + "). Check chrome://settings/content/microphone and remove any block for this extension.";
  }
};
