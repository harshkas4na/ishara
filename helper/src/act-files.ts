// act-files.ts: the read_file action (docs/AGENT-MODE.md "File read"). READ-ONLY by construction: the only fs calls are
// realpath, stat and read; nothing here can write, delete, move or list. The path rules are pure (checkReadPath) so they are
// tested to death, and the executor (readFileForAgent) takes its fs and redactor as arguments so tests never touch a disk.
import { homedir } from "node:os";
import { resolve, sep, basename } from "node:path";
import { promises as fsp, constants as FS } from "node:fs";
import { readerCore } from "./redact.ts";

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_FILE_CHARS = 12_000;       // what reaches the model, after redaction
const SNIFF_BYTES = 8192;

// The name rule from the plan, widened by audit 4 (section 2). Case-insensitive, on the NORMALISED file name only (NFKC,
// look-alike letters mapped), so "kеy.txt" with a Cyrillic е is still "key"; dotfiles are refused by the dot rule before this.
export const SECRET_NAME = /key|secret|token|password|passwd|passphrase|wallet|seed|mnemonic|private|credential|\.env|\.pem|\.p12|\.pfx|\.jks|\.kdbx|\.ovpn|keychain|id_(?:rsa|dsa|ecdsa|ed25519)|\.ppk|cookies|login data|recovery|backup.?codes?|2fa|otp/i;
const BLOCKED_TOP = new Set([".ssh", ".config", ".aws", ".gnupg"]);
// ~/Library holds mail, messages, browser profiles and app tokens as plain files, so none of it is read (audit 4, section 2).
const BLOCKED_TOP_CI = new Set(["library", "applications"]);
// Cyrillic and Greek letters that look Latin, for the name rule only.
const LOOKALIKE: Record<string, string> = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ѕ": "s", "ј": "j", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "α": "a", "ε": "e", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u" };
const plainName = (n: string): string => n.normalize("NFKC").toLowerCase().replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "").replace(/./gu, (c) => LOOKALIKE[c] ?? c);
/** A private key in the text (PEM/OpenSSH/PuTTY): the whole file is refused, not redacted line by line. */
export const PRIVATE_KEY_TEXT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|PuTTY-User-Key-File|-----BEGIN PGP PRIVATE KEY BLOCK-----/;

export type PathCheck = { ok: true; path: string } | { ok: false; why: string };

/** Expand ~ and decide whether `raw` may be read. Pure: no fs. `home` is the user's home directory. */
export function checkReadPath(raw: string, home: string = homedir()): PathCheck {
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return { ok: false, why: "that is not a file path" };
  const expanded = s === "~" ? home : s.startsWith("~/") ? home + s.slice(1) : s;
  if (!expanded.startsWith("/")) return { ok: false, why: "give the full path, starting with ~/ or /Users/…" };
  const p = resolve(expanded);
  const h = resolve(home);
  if (p === h || !p.startsWith(h + sep)) return { ok: false, why: "I only read files inside your home folder" };
  const segs = p.slice(h.length + 1).split(sep);
  const top = segs[0] ?? "";
  if (BLOCKED_TOP.has(top)) return { ok: false, why: `${top} holds credentials, so I never read it` };
  if (segs.length >= 2 && top.toLowerCase() === "library" && segs[1].toLowerCase() === "keychains") return { ok: false, why: "Keychains hold passwords, so I never read them" };
  if (BLOCKED_TOP_CI.has(top.toLowerCase())) return { ok: false, why: `~/${top} holds mail, messages, browser data and app tokens, so I never read it` };
  const dot = segs.find((x) => x.startsWith("."));
  if (dot) return { ok: false, why: `"${dot.slice(0, 40)}" is hidden (a dotfile or dot folder), so I do not read it` };
  const name = basename(p);
  if (SECRET_NAME.test(plainName(name)) || segs.slice(0, -1).some((d) => /^(?:keys?|secrets?|credentials?|wallets?|private)$/i.test(plainName(d)))) return { ok: false, why: `"${name.slice(0, 40)}" looks like it holds a key, token, password or seed, so I do not read it` };
  return { ok: true, path: p };
}

export type ReadOut = { ok: boolean; detail: string; data?: string };
export type FileDeps = {
  home: string;
  realpath: (p: string) => Promise<string>;
  stat: (p: string) => Promise<{ isFile: boolean; size: number; nlink?: number; ino?: number; dev?: number }>;
  /** Reads at most `max` bytes. The real one opens without following links and checks it is the file `expect` describes. */
  read: (p: string, max: number, expect?: { ino?: number; dev?: number }) => Promise<Buffer>;
  /** The helper's redaction, applied to the text before it can reach 0GM. */
  redact: (text: string) => string;
};

/** The shared redaction rules (blocks-core.js via redact.ts), line by line plus the seed-phrase run mask. Throws if they are missing: never sends raw text instead. */
export function redactText(text: string): string {
  const B = readerCore() as ReturnType<typeof readerCore> & { phraseRunMask(texts: string[]): boolean[] };
  const lines = text.split("\n").map((l) => B.redact(l));
  const mask = B.phraseRunMask(lines);
  return lines.map((l, i) => (mask[i] ? B.REDACTED : l)).join("\n");
}

export const realFileDeps = (): FileDeps => ({
  home: homedir(),
  realpath: (p) => fsp.realpath(p),
  stat: async (p) => { const s = await fsp.lstat(p); return { isFile: s.isFile(), size: s.size, nlink: s.nlink, ino: s.ino, dev: s.dev }; },
  // O_NOFOLLOW + fstat: a file swapped for a link (or another file) between the checks and the read is refused (TOCTOU, audit 4).
  read: async (p, max, expect) => {
    const fh = await fsp.open(p, FS.O_RDONLY | FS.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.nlink > 1 || (expect?.ino !== undefined && (st.ino !== expect.ino || st.dev !== expect.dev))) throw new Error("the file changed while I was reading it");
      const b = Buffer.alloc(max); const { bytesRead } = await fh.read(b, 0, max, 0); return b.subarray(0, bytesRead);
    } finally { await fh.close(); }
  },
  redact: redactText,
});

const tilde = (p: string, home: string) => (p.startsWith(home + sep) ? "~" + p.slice(home.length) : p);

/** Read one text file for the agent. Never throws; every refusal says why in words the model and the person can use. */
export async function readFileForAgent(rawPath: string, d: FileDeps = realFileDeps()): Promise<ReadOut> {
  try {
    const c = checkReadPath(rawPath, d.home);
    if (!c.ok) return { ok: false, detail: c.why };
    // Resolve links and check again: a symlink inside home that points at ~/.ssh or outside home must not get through.
    let real: string;
    try { real = await d.realpath(c.path); } catch { return { ok: false, detail: "I can't find that file" }; }
    let homeReal = d.home; try { homeReal = await d.realpath(d.home); } catch { /* use as given */ }
    const c2 = checkReadPath(real, homeReal);
    if (!c2.ok) return { ok: false, detail: c2.why };
    const st = await d.stat(c2.path);
    if (!st.isFile) return { ok: false, detail: "that is a folder or special file, not a text file" };
    // A hard link is a second name for the same file: ~/Documents/notes.txt may BE ~/.ssh/id_ed25519 (audit 4, section 2).
    if ((st.nlink ?? 1) > 1) return { ok: false, detail: "that file has more than one name (a hard link), so I can't tell where it really lives; I do not read it" };
    if (st.size > MAX_FILE_BYTES) return { ok: false, detail: `that file is ${Math.round(st.size / 1024)} KB; I read text files up to 200 KB` };
    const buf = await d.read(c2.path, MAX_FILE_BYTES + 1, { ino: st.ino, dev: st.dev });
    if (buf.length > MAX_FILE_BYTES) return { ok: false, detail: "that file is over 200 KB; I read text files up to 200 KB" };
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, detail: "that looks like a binary file, not text" };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return { ok: false, detail: "that file is not UTF-8 text" }; }
    if (PRIVATE_KEY_TEXT.test(text)) return { ok: false, detail: "that file holds a private key, so I do not read it" };
    const clean = d.redact(text).replace(/\r\n/g, "\n");
    const cut = clean.length > MAX_FILE_CHARS;
    const shown = tilde(c.path, d.home);
    return { ok: true, detail: `read ${buf.length} bytes from ${shown}${cut ? ` (showing the first ${MAX_FILE_CHARS} characters)` : ""}`, data: clean.slice(0, MAX_FILE_CHARS) };
  } catch (e: any) {
    return { ok: false, detail: `could not read it: ${String(e?.message ?? e).slice(0, 80)}` };
  }
}
