// One place for the app name and the numbers the whole product agrees on.
// Renaming the project is a one-line edit of APP_NAME (the extension manifest is generated from the same name).
export const APP_NAME = "Ishara";

export const HELPER_PORT = 7777;

// Gate numbers, measured in the pre-event lab and kept here so tests and the UI quote the same values.
// laya must be at least this sure that 0GM's pick is what the user asked for. Measured on the mock verify page
// (2026-11-05): correct picks scored 0.29-0.87, wrong picks and vague asks 0.00-0.25 (one near-synonym, 0.85).
export const VERIFY_MIN_P = 0.4;
// laya stalled 2 of 40 calls in the lab, so every call gets a cut-off. Was 4000: on the slow router of 6 Nov evening laya
// timed out on correct pointers, and a timed-out laya means "explain, don't point", so the desktop never pointed. ISHARA_LAYA_MS overrides.
export const LAYA_TIMEOUT_MS = ((v) => (Number.isFinite(v) && v >= 1000 && v <= 60000 ? v : 10000))(Number(process.env.ISHARA_LAYA_MS));
export const BRAIN_TIMEOUT_MS = 8000;

// The extension's id is fixed by the "key" in extension/manifest.json, so the helper can accept requests from this
// extension only. Another installed extension (or a different build) cannot spend the 0G key's calls.
export const EXTENSION_ID = "klblmocbilliepigooglmeaalncfggbg";
