// Server-Sent Events parser. Classic script, UMD-style: the service worker imports it for its side effect
// (globalThis.IsharaSSE), the preview page loads it with a <script> tag, and node tests load it too.
// WHY its own file: this is the risky part of the stream relay (frames split across network chunks, CRLF,
// multi-byte characters cut in half), so it must be testable without a browser.
//
// Follows the WHATWG EventSource rules: lines end in CRLF, LF or CR; a blank line ends a frame; lines starting with
// ":" are comments (the helper sends them as keep-alives); "data:" lines of one frame join with "\n"; a frame with
// no data line is dropped; an unfinished frame at end of stream is dropped (it was never complete, so never trusted).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.IsharaSSE = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  // onEvent({event, data}) gets the raw data STRING; callers JSON.parse it themselves so one bad frame
  // cannot kill the stream.
  function createParser(onEvent) {
    const dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
    let buf = "", ev = "", data = [], hasData = false, skipLF = false, first = true;

    function line(l) {
      if (l === "") { // blank line: dispatch
        if (hasData) onEvent({ event: ev || "message", data: data.join("\n") });
        ev = ""; data = []; hasData = false;
        return;
      }
      if (l[0] === ":") return; // comment / keep-alive
      const i = l.indexOf(":");
      const field = i < 0 ? l : l.slice(0, i);
      let value = i < 0 ? "" : l.slice(i + 1);
      if (value[0] === " ") value = value.slice(1); // exactly one leading space is part of the syntax
      if (field === "event") ev = value;
      else if (field === "data") { data.push(value); hasData = true; }
      // id and retry are not used by the helper
    }

    // chunk: Uint8Array (from a fetch reader) or string (tests).
    function push(chunk) {
      let text = typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }); // stream:true holds a split UTF-8 sequence
      if (first && text.length) { first = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
      if (skipLF && text.length) { if (text[0] === "\n") text = text.slice(1); skipLF = false; } // CR at the end of the last chunk, LF at the start of this
      buf += text;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c !== "\n" && c !== "\r") continue;
        const l = buf.slice(start, i);
        if (c === "\r") {
          if (buf[i + 1] === "\n") i++;
          else if (i + 1 === buf.length) skipLF = true; // might be the first half of CRLF
        }
        start = i + 1;
        line(l);
      }
      buf = buf.slice(start);
    }

    // End of stream: flush the decoder; an incomplete trailing frame is discarded on purpose.
    function end() { if (dec) dec.decode(); buf = ""; ev = ""; data = []; hasData = false; }

    return { push, end };
  }

  // The relay's core, kept here (no chrome.* inside) so node can test it with a fake fetch.
  // Reads the helper's event stream and calls post({event, data}) with data already parsed. It never throws.
  //  - HTTP 404/405 means the helper has no /tutor: post a synthetic "noroute" so the page can fall back to /decide.
  //  - any other failure to start, or a dropped connection before the first event: a synthetic `refused`
  //    (cause "offline"), the same product rule as the helper's own: no answer is better than an invented one.
  //  - a stream that ends after some events but without done/refused: a synthetic done with outcome "cutoff".
  //  - an abort (new question, port closed) is silent: the caller already moved on.
  // NOTE the helper keeps draining 0G for the proof when we cancel the reader; cancelling here only stops relaying.
  // Options for other streams (POST /act, docs/AGENT-MODE.md): `known` replaces the event names let through, `terminals` the events
  // that end the stream, `cutoff(seen)` and `offline(cause)` build the synthetic {event, data} used when it ends without one / cannot start.
  // The defaults are the /tutor stream, unchanged.
  async function relay({ fetchFn, url, init, signal, post, known: knownList, terminals, cutoff, offlineEvent }) {
    // "speaking" (the helper started playing a sentence) arrives AFTER `done` too, so it must not count as terminal.
    const known = new Set(knownList || ["thinking", "say", "point", "step", "speaking", "done", "refused"]);
    const ends = new Set(terminals || ["done", "refused"]);
    let seen = 0, terminal = false;
    const emit = (event, data) => { if (signal && signal.aborted) return; if (ends.has(event)) terminal = true; seen++; post({ event, data }); };
    const offline = () => { const o = offlineEvent ? offlineEvent("offline") : { event: "refused", data: { cause: "offline", say: "" } }; emit(o.event, o.data); };
    let res;
    try { res = await fetchFn(url, { ...init, signal }); } catch { if (!(signal && signal.aborted)) offline(); return; }
    if (res.status === 404 || res.status === 405) { if (!(signal && signal.aborted)) post({ event: "noroute", data: {} }); return; }
    if (!res.ok || !res.body) { const o = offlineEvent ? offlineEvent("unavailable") : { event: "refused", data: { cause: "unavailable", say: "" } }; emit(o.event, o.data); return; }
    const parser = createParser(({ event, data }) => {
      if (!known.has(event)) return; // unknown events are skipped, not fatal: the contract may grow
      let d; try { d = JSON.parse(data || "{}"); } catch { return; } // one bad frame must not kill the stream
      emit(event, d);
    });
    const reader = res.body.getReader();
    if (signal) signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch {
      if (signal && signal.aborted) return;
      if (!seen) return offline();
    }
    parser.end();
    if (signal && signal.aborted) return;
    if (!terminal) {
      if (!seen) offline();
      else if (cutoff) { const o = cutoff(); emit(o.event, o.data); }
      else emit("done", { mode: "explain", outcome: "cutoff", requestIds: { laya: [] }, ms: { total: 0 } });
    }
  }

  return { createParser, relay };
});
