# Duke Checkout Extension — Stage 4 Implementation Plan (Distribution)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Ship it to the private group: a repeatable CRX pack script with a stable extension ID, an `update.xml` for auto-updates, documented install + release workflow, and docs that state the security model.

**Prereq:** Stages 1-3 merged (`dist-extension/` builds; 307 tests green incl. Stage-1/2/3 integration).

**Key facts that shape this stage:**
- Chrome self-hosted auto-update requires **`"update_url"` in the packed manifest** pointing at a hosted `update.xml`; and a **stable extension ID** derived from a private key (`.pem`) that must be kept secret and reused forever (regenerating it changes the ID and breaks updates + friend installs).
- A `.crx` is produced by Chrome itself: `chrome --pack-extension=<dir> [--pack-extension-key=<file.pem>]`.
- The extension ID = first 16 bytes of `sha256(public-key-DER)`, each byte's nibbles mapped to `a`-`p`.

---

### Task 1: Pack script + update.xml generator (+ tests)

**Files:** `scripts/pack-extension.ts` (new), `tests/pack-extension.test.ts` (new), `package.json` (script `pack:crx`), `.gitignore` (already covers `*.crx`, `*.pem` — verify), `src/extension/manifest.json` (no update_url here; injected only at pack time).

- [ ] `extensionIdFromPublicKey(derBuffer: Buffer): string` — pure, tested: sha256 → first 16 bytes → hex → map each hex digit to `a`+digit (nibble arithmetic per the standard algorithm) → 32-char id.
- [ ] `updateXml(appId: string, version: string, crxUrl: string): string` — pure, tested: the standard `<gupdate>/<app appid><updatecheck codebase version/>` document with the Google namespace, XML-escaped URL.
- [ ] `pack()` flow in `scripts/pack-extension.ts`:
  1. `npm run build:ext` (or assert `dist-extension/` is fresh — prefer running the build).
  2. Read `DUKE_UPDATE_URL` from the environment (required for a release pack; if absent, log a clear warning and pack without `update_url`, documented as a local/test pack).
  3. Copy `dist-extension/` to a temp dir, inject `"update_url": "<DUKE_UPDATE_URL>"` into the copied `manifest.json` when provided, and bump nothing else.
  4. Resolve a Chrome executable (reuse the resolution used by the integration harness — check how `puppeteer-core`'s browser is located; fall back to `CHROME_PATH` env or common paths) and run `--pack-extension=<tmp> --pack-extension-key=<key>`.
  5. Key handling: use `DUKE_CRX_KEY` env (path) or `./duke-extension.pem` if present; if missing, generate one by packing without `--pack-extension-key` (Chrome writes `<dir>.pem`) and move it to the stable path — then print a LOUD warning that this key must be kept secret and never regenerated.
  6. Output `release/duke-checkout.crx` + `release/update.xml` (appId from the key, version from the manifest, crxUrl from `DUKE_UPDATE_URL`'s directory + `duke-checkout.crx`), and print the extension ID + next steps.
  7. Exit non-zero with a clear message on any failure.
- [ ] Tests: `extensionIdFromPublicKey` (generate a throwaway keypair in the test via `node:crypto` `generateKeyPairSync('rsa')`, export the public key DER, and assert a 32-char `a`-`p` id — plus a known-vector test if you can compute one deterministically), `updateXml` output shape/escaping, and a version-consistency test: `manifest.json` version shape (`^\d+\.\d+\.\d+$`).
- [ ] Document in the script header: key custody, ID stability, and that `update_url` is injected only for releases.
- [ ] Verify: `npx vitest run`, `npm run check`, and a dry run `DUKE_UPDATE_URL=https://example.invalid/duke/ npx tsx scripts/pack-extension.ts` producing `release/*` (then clean up `release/` — add it to `.gitignore`).
- [ ] Commit.

### Task 2: Documentation — install, release, security model

**Files:** `README.md`, `docs/releases.md` (new) or a README section.

- [ ] README additions:
  - **What it is** (one paragraph) and the three surfaces (chip, app page, menu/shortcut).
  - **Install (developer)**: `npm i`, `npm run build:ext`, chrome://extensions → Load unpacked → `dist-extension/`, sign in to BIG W once, click the extension → onboarding.
  - **Install (friend)**: receive the `.crx` + `update.xml` links (or the update_url), drag the `.crx` into chrome://extensions (Developer mode) on Linux/Chrome-for-Testing; note the Windows/macOS off-store restriction and the enterprise-policy path (`ExtensionInstallForcelist`) as the robust alternative. State that auto-updates need the `update_url` build.
  - **Release checklist** (numbered): bump `manifest.json` version → `npx vitest run` + `npm run check` → `npm run pack:crx` with `DUKE_UPDATE_URL`/`DUKE_CRX_KEY` → upload `release/duke-checkout.crx` + `release/update.xml` to the static host (the same directory as `DUKE_UPDATE_URL`) → verify the version in `update.xml` matches the manifest → tell the group (or let Chrome update within hours).
  - **Security model**: reuse/extend the Stage-3 "Trigger threat model" section: trusted-gesture-only chip, `confirmBeforePay`, session-scoped card (opt-in, session storage only — wiped on browser close), auto-arm rate limit, no server, no CDP, all execution local to the user's Chrome, what the extension can and cannot do.
  - **Privacy**: what is stored locally (`chrome.storage.local`: settings/profile/history; `chrome.storage.session`: card/armed/active run), what is never stored (CVV outside a run; nothing leaves the machine).
  - **Troubleshooting**: BRIDGE_UNREADY / sign-in required / PAYMENT_NOT_READY / payment_unknown, and how to read the run history.
  - Update the existing local-app sections to mark the extension as the primary product and the local server app as legacy.
- [ ] Verify: docs only — no code changes; run `npm run check` (no-op) and confirm the README links resolve locally.
- [ ] Commit.

### Task 3: Final full-project review

- [ ] Dispatch the final reviewer (separate task) over the entire repository: Stages 1-4, all commits, exit criteria per stage, security posture, dead code/duplication, docs accuracy vs behaviour, and a final verdict on release-readiness for the private group.

---

## Stage-4 exit criteria
- `npm run pack:crx` produces a CRX with a stable ID and an `update.xml` whose version/appid match the pushed manifest.
- A friend can install once and receive updates (documented, with the platform caveats).
- README documents install, release, security, privacy, and troubleshooting; no card material in `storage.local` anywhere.
- Full suite + both builds green; final review verdict recorded.
