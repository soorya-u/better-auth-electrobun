# Plan: Loopback-based desktop auth for Better Auth

Status: **proposed** (not implemented)
Owner: —
Supersedes: the custom-URL-scheme deep-link hand-off in the current package.

---

## 1. Background & problem

Browser-based OAuth for a desktop app needs a "hand-off": OAuth completes in the
**system browser**, and the resulting session must get back into the **desktop
app**. The current package does this with a **custom URL scheme** deep link
(`dev.app.id://auth/callback#token=…`) and Electrobun's `open-url` event.

That mechanism is **macOS-only**:

- Electrobun wires `setURLOpenHandler` only under `process.platform === "darwin"`
  (`native.ts` literally comments "URL scheme handler (macOS only)").
- Electrobun's Linux `.desktop` output has no `MimeType=x-scheme-handler/…` and
  `Exec=launcher` (no `%u`); Windows gets nothing. No `second-instance` / argv /
  single-instance path exists anywhere in the framework.
- Every shipping Electrobun app that does OAuth (e.g. `chronos-calendar`,
  `cartridge`) uses the same `open-url` path and is therefore mac-only; none
  implement Linux/Windows.

Electron *does* support all platforms, but only because it adds the **argv +
single-instance-lock + `second-instance`** path on top of macOS `open-url`.
Electron apps still have to wire that themselves, and many get it wrong.

**Goal:** a hand-off that works on **macOS, Linux, and Windows**, with no OS
scheme registration, usable by **Electrobun now** and **Electron (and any
desktop runtime) later**.

---

## 2. Solution: loopback navigation hand-off

The desktop main process runs a tiny **loopback HTTP server** on
`127.0.0.1:<ephemeral-port>`. After OAuth completes, the Better Auth **server**
plugin **302-redirects the system browser directly to the loopback URL** with the
one-time code:

```
http://127.0.0.1:<port>/<callbackPath>?token=<redirectToken>&nonce=<nonce>
```

The loopback server (desktop) receives the GET, exchanges the one-time code for a
session (existing PKCE flow), notifies the renderer, and returns a small "you can
close this tab" HTML page.

### Why navigation, not fetch

A **top-level navigation** to `127.0.0.1` is exempt from the constraints that
would otherwise bite a `fetch`:

- **No CORS** — navigations aren't subject to CORS.
- **No Private Network Access preflight** — PNA applies to subresource requests,
  not navigations.
- **No mixed-content block** — top-level navigation isn't mixed content, and
  `127.0.0.1` is a trustworthy origin anyway.

This is the decisive simplification: it also removes the need for a web callback
page in the desktop path.

---

## 2a. Build principles

- **Reuse Better Auth, don't reinvent.** Use `createAuthEndpoint`,
  `sessionMiddleware`, the cookie helpers (`setSignedCookie`/`getSignedCookie`,
  `createAuthCookie`), crypto/PKCE (`createHash`, `generateRandomString`,
  `base64Url`), `getBaseURL`, `parseUserOutput`, `internalAdapter`
  verification-value APIs, etc. The one-time-code mint/verify already does this.
- **Use `@better-fetch/fetch`** for all HTTP (it's already a dependency and is
  what Better Auth itself uses) — server-internal calls (`/sign-in/social`,
  `/electrobun/token`) and any adapter-side requests.
- **Keep the per-runtime surface tiny.** Everything non-trivial lives in
  framework-agnostic `core/` + `server/`; adapters only bind a socket, open a
  browser, and post an event to the renderer.

## 3. Researched catches (and how this plan handles each)

| Catch | Detail | Handling |
|---|---|---|
| Mixed content | `http://127.0.0.1` is whitelisted; the hostname `localhost` is **not** universally | Always use `127.0.0.1`, never `localhost`, in the redirect URL |
| Private Network Access | Chrome blocks `https → 127.0.0.1` **fetches** w/o `Access-Control-Allow-Private-Network: true` | Use **navigation**, not fetch → PNA does not apply. (If a fetch variant is ever added, send the PNA + CORS headers.) |
| Token in URL query | Visible in browser history/logs | Token is **one-time** and **PKCE-bound** (verifier held only by the desktop); exchanged immediately. Acceptable, and standard for loopback OAuth (RFC 8252). |
| Port discovery | The server must know which port to redirect to | Desktop picks an **ephemeral port** at sign-in, passes it (and a `nonce`) into the OAuth init; server carries it through the PKCE transfer payload and uses it to build the loopback redirect. |
| Port conflicts / multi-instance | Fixed ports collide across instances | Ephemeral port per app instance; bind to `127.0.0.1` only. |
| Untrusted local callers | Any local process/site could hit the loopback | Bind `127.0.0.1` (not `0.0.0.0`); require the `nonce`; rely on one-time + PKCE token; short TTL; ignore unknown paths. |
| Server lifetime | Must be listening before the redirect arrives | Start the loopback on `requestAuth` (or app launch); stop after success or timeout. |
| Can't auto-close the tab | Browser won't let the page close itself reliably | Serve a clean "Signed in — you can close this tab" page; optionally focus the app window via the renderer. |
| `better-auth` redirect validation | `callbackURL` is validated against `trustedOrigins` | The plugin sets `Location` itself (not a user-supplied `callbackURL`), bypassing that check; still validate the loopback shape internally. |
| macOS firewall prompt | Binding a listener can prompt | Binding to `127.0.0.1` typically avoids the "accept incoming connections" prompt; document it. |

---

## 4. What we keep vs. change (existing code is **not** wasted)

Most of the current package is reused; only the **hand-off transport** swaps.

**Keep (≈ unchanged):**
- Server: `init-oauth-proxy`, `oauth-complete`, `/electrobun/token`,
  `handleTransfer`, PKCE verification, `oAuthProxy` composition.
- Desktop client: `requestAuth` (opens system browser), `authenticate`
  (one-time-code → session exchange), keychain `storage`.
- Renderer ↔ main RPC (`onAuthenticated`, `getUser`, etc.).

**Change:**
- `oauth-complete` redirect target: instead of `webCallbackUrl#token`, redirect
  to `http://127.0.0.1:<port>/<cb>?token=…&nonce=…` (carry port/nonce through the
  PKCE transfer payload).
- Desktop `setupMain`: replace the `open-url` listener with a **loopback server**
  that receives the code and calls `authenticate()`.

**Drop:**
- Custom-scheme `protocol`, `handleDeepLink`, the `open-url` event listener, and
  `urlSchemes` config — gone (no macOS deep-link fast path; loopback everywhere).

**Repurpose:**
- The web `electrobunCallbackClient` becomes an **optional** `forwardToDesktop()`
  helper for a branded callback page; not used in the default direct-to-loopback
  flow.

---

## 5. Architecture & flow

```
WebView (renderer)            Bun/Node main process            Better Auth server
      │  signIn.social()            │                                  │
      ├── RPC: requestAuth ────────▶│                                  │
      │                             │ start loopback 127.0.0.1:PORT    │
      │                             │ openExternal(                    │
      │                             │   SERVER/.../init-oauth-proxy    │
      │                             │   ?provider&pkce&callbackURL=http://127.0.0.1:PORT/cb?nonce=N)
      │                             │                                  │
   [ system browser ] ── GitHub OAuth ──▶ provider ──▶ SERVER callback / oauth-proxy-callback
      │                             │                                  │ session established
      │                             │                                  │ oauth-complete (callbackURL carried):
      │                             │                                  │  mint token; 302 → http://127.0.0.1:PORT/cb?nonce=N&token=T
      │                             │                                  │  (or, if webCallbackUrl set:
      │                             │                                  │   302 → webCallbackUrl#token=T&loopback=…,
      │                             │                                  │   page calls forwardToDesktop())
   [ system browser ] ── navigates to 127.0.0.1:PORT/cb?token=T&nonce=N
      │                             │ loopback GET handler:            │
      │                             │  verify nonce                    │
      │                             │  authenticate(T) ───────────────▶│ /electrobun/token (PKCE verify)
      │                             │  ◀── session ────────────────────│
      │                             │  store session (keychain)        │
      │◀─ RPC: onAuthenticated ─────┤  respond 200 "close this tab"    │
      │  navigate("/threads")       │  stop loopback                   │
```

Works identically in dev (with `oAuthProxy` bouncing through
`/oauth-proxy-callback` first) and prod (direct `/callback/:provider`), because
both converge on `oauth-complete`, which performs the loopback redirect.

---

## 6. Package / project structure

Rename/retarget the package to be runtime-agnostic (suggested name:
`@better-auth/desktop-loopback`, or keep current name with new subpaths). Split
into a framework-agnostic core + thin per-runtime adapters.

```
src/
  server/                 # Better Auth SERVER plugin (framework-agnostic)
    plugin.ts             #   init-oauth-proxy, oauth-complete, token, handleTransfer
    routes.ts
  core/                   # framework-agnostic desktop logic
    loopback.ts           #   port/nonce mgmt, redirect-URL builder, request parsing
    exchange.ts           #   one-time-code → session (PKCE) — current authenticate()
    storage.ts            #   keychain (Bun.secrets / OS keychain)
    types.ts              #   DesktopAdapter interface (below)
    client.ts             #   Better Auth CLIENT plugin: requestAuth/authenticate actions
  adapters/
    electrobun.ts         #   Bun.serve loopback, Utils.openExternal, BrowserView RPC
    electron.ts           #   node http loopback, shell.openExternal, ipcMain/ipcRenderer
  web/                    # OPTIONAL: branded callback page helper
    forward-to-desktop.ts #   forwardToDesktop(): navigate browser → 127.0.0.1 loopback
                          #   (unused in the default direct-to-loopback flow)
```

Exports:
- `./server` — `betterAuthDesktop()` server plugin.
- `./client` — renderer client plugin.
- `./electrobun` — `createElectrobunDesktopAuth(...)`.
- `./electron` — `createElectronDesktopAuth(...)`.
- `./core` — shared types/utilities for custom adapters.

### `DesktopAdapter` interface (the only per-runtime surface)

```ts
type DesktopAdapter = {
  // open the system browser at an external URL
  openExternal(url: string): Promise<void> | void;
  // start an http listener on 127.0.0.1; return the chosen port; call onRequest per hit
  serveLoopback(onRequest: (req: LoopbackRequest) => Promise<LoopbackResponse>): Promise<{ port: number; close(): void }>;
  // push an event to the renderer (onAuthenticated / onAuthError / onUserUpdated)
  notifyRenderer(event: AuthEvent): void;
  // keychain-backed storage
  storage: Storage;
};
```

Electrobun and Electron each implement this; the core flow is identical.

---

## 7. API design (consumer-facing)

**Server (Cloudflare/Hono/etc.):**
```ts
betterAuth({
  plugins: [
    betterAuthDesktop({
      hashKey: "token",          // name of the one-time code param
      // Default: redirect straight to the desktop loopback (127.0.0.1).
      // Optional branding: redirect to your page first; it calls forwardToDesktop().
      webCallbackUrl?: "https://app.example.com/auth/callback",
      allowedLoopbackPorts?: ... // optional hardening: range/allowlist
    }),
    oAuthProxy({ ... }),         // still composes for dev
  ],
});
```

**Desktop (Electrobun):**
```ts
const auth = createElectrobunDesktopAuth({
  serverURL: env.SERVER_URL,
  clientID: "my-desktop-app",
  getWindow: () => mainWindow,   // for RPC
  loopbackPort?: 51789,          // optional; omit to bind 127.0.0.1:0 (OS-assigned)
});
new BrowserWindow({ rpc: auth.rpc, url });
await auth.setup();              // registers loopback-on-demand + RPC handlers
```

**Desktop (Electron) — future:**
```ts
const auth = createElectronDesktopAuth({
  serverURL, clientID,
  getWindow: () => mainWindow,   // for IPC
});
await auth.setup();
```

**Renderer (any framework):**
```ts
// auth.requestAuth({ provider: "github" })  → triggers the whole flow
// auth.onAuthenticated(user => navigate("/threads"))
```

**Optional branded web callback page** (only if `webCallbackUrl` is set):
```ts
// on your /auth/callback page — successor to the old forwardCallback():
import { forwardToDesktop } from "@soorya-u/better-auth-desktop/web";
// reads token + loopback from the URL fragment, navigates the browser to
// http://127.0.0.1:<port>/cb?token=… (a top-level navigation; no CORS/PNA)
forwardToDesktop();
```

---

## 8. Implementation steps (phased)

**Phase 0 — server redirect target**
1. `init-oauth-proxy` accepts `loopback_port` + `loopback_nonce`, stores them in
   the PKCE transfer payload (signed cookie / verification value).
2. `oauth-complete` builds `http://127.0.0.1:<port>/<cb>?token=…&nonce=…` and
   302s there (instead of `webCallbackUrl#token`).

**Phase 1 — core + electrobun adapter**
3. Extract framework-agnostic `core/` (loopback protocol, exchange, storage,
   client plugin, `DesktopAdapter` type).
4. Implement `adapters/electrobun.ts`: `Bun.serve` on `127.0.0.1:0`,
   `Utils.openExternal`, `BrowserView` RPC; `setup()` wires `requestAuth` to
   start the loopback, open the browser, and resolve on the loopback hit.
5. Loopback GET handler: validate nonce → `authenticate(token)` →
   `notifyRenderer(onAuthenticated)` → 200 HTML → close server.

**Phase 2 — integrate in cyrus**
6. Swap desktop `auth.ts`/`bun/index.ts` to the new adapter; drop the web
   `electrobunCallbackClient` + scheme config.
7. End-to-end test on Linux (the case that's currently broken).

**Phase 3 — electron adapter**
8. Implement `adapters/electron.ts` (node `http`, `shell.openExternal`,
   `ipcMain`/`ipcRenderer`). Same core; verify on all three OSes.

**Phase 4 — polish**
9. Optional macOS deep-link fast path (kept behind a flag).
10. Docs + example apps for Electrobun and Electron.

---

## 9. Acceptance criteria

- [ ] Desktop social sign-in (GitHub) completes end-to-end on **Linux**,
      **macOS**, and **Windows**, with **no OS URL-scheme registration**.
- [ ] Works in **dev** (with `oAuthProxy` bounce) and **prod** (direct callback).
- [ ] No CORS / PNA / mixed-content errors in any supported browser (verified in
      Chrome, Firefox, Safari): the flow uses a top-level navigation to
      `127.0.0.1`.
- [ ] Loopback binds to `127.0.0.1` only; never `0.0.0.0`.
- [ ] One-time code is single-use and PKCE-verified; replay fails; a request with
      a wrong/missing `nonce` is rejected.
- [ ] Loopback server starts on demand and is closed after success or a timeout
      (no lingering open port).
- [ ] After success, the renderer receives `onAuthenticated` and navigates;
      the browser shows a "you can close this tab" page.
- [ ] The same `core/` + `server/` power both the Electrobun and Electron
      adapters with no flow divergence.
- [ ] Typecheck, build, and the package's existing tests pass; new tests cover
      loopback request parsing, nonce/one-time enforcement, and redirect-URL
      building.

---

## 10. Decisions (resolved)

1. **Port: configurable, ephemeral by default.** The desktop adapter accepts an
   optional `port`. If provided, use it; if omitted, bind `127.0.0.1:0` and let
   the OS pick an open port. Either way the chosen port is carried into the flow
   (see #2).
2. **Carry the loopback destination via the standard `callbackURL`** (RFC 8252
   convention; what desktop devs expect). The desktop builds its loopback URL
   `http://127.0.0.1:<port>/cb?nonce=<N>` and passes it as the `callbackURL`.
   Better Auth + `oAuthProxy` already carry `callbackURL` through the full
   round-trip. Because the server must still mint and append the one-time token,
   `init-oauth-proxy` wraps it: it sets the internal sign-in `callbackURL` to
   `${baseURL}/electrobun/oauth-complete?redirect=<encoded loopback URL>`;
   `oauth-complete` mints the token, validates `redirect` is a `127.0.0.1` URL,
   and redirects to `<redirect>?token=<code>`. No separate cookie/query for
   port/nonce — they live inside the `callbackURL` the desktop supplies.
3. **Default: redirect straight to the loopback; web callback page is opt-in
   branding.**
   - **Default** — `oauth-complete` 302s the browser directly to
     `127.0.0.1:<port>?token=…`. The desktop `open-url` event listener is
     **removed** (the loopback server replaces it); the web `/auth/callback`
     route is **not** used.
   - **Optional branded page** — the consumer may configure a `webCallbackUrl`
     (their own page). Then `oauth-complete` redirects to
     `webCallbackUrl#token=<code>&loopback=<encoded loopback URL>`, and the page
     calls a provided client helper **`forwardToDesktop()`** (the loopback
     successor to `forwardCallback`) that navigates the browser to
     `<loopback>?token=<code>`. Both default and branded use a **top-level
     navigation** to `127.0.0.1`, so neither hits CORS/PNA/mixed-content.
4. **No macOS deep-link fast path.** Loopback works on macOS too; not worth
   maintaining a second mechanism.
5. **Package: single runtime-agnostic package with subpath adapters (Option A).**
   Rename `@soorya-u/better-auth-electrobun` → `@soorya-u/better-auth-desktop`,
   with subpath imports such as `@soorya-u/better-auth-desktop/electrobun`,
   `.../electron`, `.../server`, `.../client`, `.../web`, `.../core`. Consumers
   import only their runtime's subpath (Electron apps never load Electrobun code),
   matching the isolation the current package already relies on. Revisit a scoped
   monorepo only if an adapter's peer deps start polluting others.
6. **Windows verification (checklist, not a design change).** Confirm that
   binding `127.0.0.1` (never `0.0.0.0`) avoids the Windows Defender Firewall
   prompt, and that a browser navigation to `http://127.0.0.1:<port>` reaches the
   loopback with no SmartScreen/loopback interference.

---

## 11. Security notes

- Bind `127.0.0.1` only; the listener is unreachable off-box.
- The token in the loopback URL is a one-time, short-TTL, PKCE-bound code; the
  verifier never leaves the desktop, so interception/replay is useless.
- Require the `nonce` so a different local app can't consume the redirect.
- Close the loopback immediately after a successful exchange (or on timeout) to
  minimize the window.
- Never log the token; treat the loopback request as sensitive.

---

## 12. Why this also fits Electron

Electron *can* deep-link, but it's per-OS fiddly (Registry on Windows, `.desktop`
+ `xdg` on Linux, single-instance lock + `second-instance` to forward argv, plus
dev-mode `setAsDefaultProtocolClient(execPath, [script])`). The loopback flow
needs **none** of that: just `shell.openExternal` + a `127.0.0.1` `http` server +
IPC. One code path, three OSes, no installation-time registration — which is why
this plan targets a shared `core/` with thin `electrobun` / `electron` adapters.
