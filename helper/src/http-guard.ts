// Who may talk to the helper, and which files the static routes may serve. Pure functions, tested in helper.test.ts.
import { join, normalize } from "node:path";
import { HELPER_PORT, EXTENSION_ID } from "./config.ts";

const SELF = new Set([`http://127.0.0.1:${HELPER_PORT}`, `http://localhost:${HELPER_PORT}`]);

// Only OUR extension (its id is pinned by the manifest "key") and the helper's own pages.
export const allowedOrigin = (o: string): boolean => o === `chrome-extension://${EXTENSION_ID}` || SELF.has(o);

// The helper holds the 0G key. CORS only hides responses from other sites; it does not stop a page from SENDING a
// simple POST (text/plain) that spends 0G calls or ends a session. And without a Host check, DNS rebinding lets any
// site read the logs. So: a foreign Host, or a foreign Origin (browsers always send one cross-site), is refused.
// Requests with no Origin (curl, scripts, same-origin GETs) are allowed.
export function refuse(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !SELF.has(`http://${host.toLowerCase()}`)) return true;
  return origin !== undefined && !allowedOrigin(origin);
}

// Maps the rest of a static URL path to a file inside `dir` (which ends with "/"), or null if it would leave it.
// A bare prefix ("/app/") serves `index`.
export function staticPath(dir: string, urlRest: string, index = "index.html"): string | null {
  let rel: string;
  try { rel = normalize(decodeURIComponent(urlRest)); } catch { return null; } // malformed %-escape
  if (rel.includes("\0")) return null;
  const file = join(dir, rel && rel !== "." && rel !== "/" ? rel : index);
  return file.startsWith(dir) ? file : null;
}
