# Testing the web pages

Served by the helper at `http://127.0.0.1:7777/app/` (`npm run helper`). Use `/app/index.html`: bare `/app/` returned 403 when tested.

## Fixture switch
Add `?fixture=<name>` to any page. When present, the page reads `web/test-fixtures/<kind>-<name>.json` instead of calling the helper. Without it, nothing changes. The 0G router is not called.

| Page | Fixtures |
|---|---|
| `proof.html?id=x&fixture=` | `ok`, `mismatch`, `expired`, `error`, `unavailable`, `pending`, `unknown` |
| `replay.html?session=x&fixture=` | `ok`, `unknown` (on-chain root not checked), `mismatch`, `error` (shows the local-copy fallback), `unstored` |
| `index.html?fixture=demo` | `demo` session list |

The fixture signer addresses and hashes are made up. Real data: `replay.html?session=<id from /sessions>`.

## Checked
Landing, real stored e2e replay (verified, 3 checks), proof ok/mismatch/expired, replay ok/error: rendered in Chrome, no console errors.
Not checked: a live proof from the router (down), a phone-width viewport (window resize did not change the viewport), light mode, the Copy button.
