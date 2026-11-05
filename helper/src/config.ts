// One place for the app name and the numbers the whole product agrees on.
// Renaming the project is a one-line edit of APP_NAME (the extension manifest is generated from the same name).
export const APP_NAME = "Ishara";

export const HELPER_PORT = 7777;

// Gate numbers, measured in the pre-event lab and kept here so tests and the UI quote the same values.
export const LAYA_MIN_P = 0.45;      // laya must be at least this sure of its choice
export const LAYA_TIMEOUT_MS = 4000; // laya stalled 2 of 40 calls in the lab, so every call gets a cut-off
export const BRAIN_TIMEOUT_MS = 8000;
