// The Approve / Deny window for Agent mode (audit 4, 1.8). It is an extension page in its own window: the web page the agent is
// working on cannot read, hide, cover or click it. The worker posts the answer to the helper itself.
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
let answered = false;
chrome.runtime.sendMessage({ type: "approval-info", token }, (r) => {
  if (!r || r.error) { $("words").textContent = "This request is over."; for (const b of ["yes", "no"]) $(b).disabled = true; return; }
  $("words").textContent = r.words || "Do this step?";
  $("why").textContent = r.why || "";
  $("site").textContent = r.site ? "On " + r.site : "";
  $("no").focus(); // the safe answer has the focus, so a stray Enter or Space never approves
});
const send = (m) => { if (answered) return; answered = true; chrome.runtime.sendMessage({ type: "approval-answer", token, ...m }, () => window.close()); };
$("yes").addEventListener("click", (e) => { if (e.isTrusted) send({ yes: true }); });
$("no").addEventListener("click", () => send({ yes: false }));
$("stop").addEventListener("click", () => send({ stop: true }));
