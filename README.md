# @soorya-u/better-auth-desktop

Loopback-based desktop authentication for [Better Auth](https://better-auth.com).

OAuth completes in the **system browser** and the resulting session is handed
back to the desktop app through a **`127.0.0.1` loopback** the app briefly
listens on — reached by a **top-level browser navigation**, not a custom URL
scheme. That works on **macOS, Linux, and Windows** with **no OS scheme
registration**, and avoids the CORS / Private-Network-Access / mixed-content
problems a `fetch`-based hand-off would hit.

A framework-agnostic **server plugin** and **core** drive the flow; thin
adapters bind it to a runtime. **Electrobun** ships today; **Electron** is a
drop-in (it never loads any Electrobun code).

## How it works

```
WebView (renderer)        Desktop main process            Better Auth server
   │ requestAuth(github) ─────▶│                                  │
   │                           │ bind 127.0.0.1:<port>            │
   │                           │ openExternal(                    │
   │                           │   /desktop/init-oauth-proxy       │
   │                           │   ?provider&pkce&callbackURL=http://127.0.0.1:<port>/callback?nonce=N)
   │                           │                                  │
 [ system browser ] ── OAuth ──▶ provider ──▶ server callback ──▶ session established
   │                           │                       /desktop/oauth-complete:
   │                           │                         mint one-time code; 302 →
   │                           │                         http://127.0.0.1:<port>/callback?nonce=N&token=T
 [ system browser ] ── navigates to 127.0.0.1:<port>/callback?token=T&nonce=N
   │                           │ loopback handler:                │
   │                           │  verify nonce                    │
   │                           │  exchange T ────────────────────▶│ /desktop/token (PKCE verify)
   │                           │  ◀── session ────────────────────│
   │                           │  store session (keychain)        │
   │◀── onAuthenticated ───────┤  "you can close this tab"        │
   │  navigate("/app")         │  close loopback                  │
```

The one-time code in the loopback URL is **single-use** and **PKCE-bound** (the
verifier never leaves the desktop), the listener binds **`127.0.0.1` only**, the
request must carry the matching **nonce**, and the loopback closes after success
or a timeout. Works in dev (with `oAuthProxy` bouncing through
`/oauth-proxy-callback`) and prod (direct callback) alike.

## Installation

```bash
bun add better-auth @soorya-u/better-auth-desktop
```

## Server

Add the plugin to your Better Auth server. Compose it with `oAuthProxy` if your
desktop/web origins differ from the OAuth-registered callback origin.

```ts
// server/auth.ts
import { betterAuth } from "better-auth";
import { betterAuthDesktop } from "@soorya-u/better-auth-desktop/server";
import { oAuthProxy } from "better-auth/plugins";

export const auth = betterAuth({
  socialProviders: {
    github: {
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID!,
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET!,
    },
  },
  plugins: [
    betterAuthDesktop({ clientID: "my-desktop-app" }),
    oAuthProxy(),
  ],
});
```

### Server options

| Option | Default | Description |
| --- | --- | --- |
| `clientID` | `"desktop"` | Must match the desktop adapter's `clientID`. |
| `codeExpiresIn` | `300` | One-time-code TTL (seconds). |
| `hashKey` | `"token"` | Name of the one-time-code parameter. |
| `webCallbackUrl` | — | Optional branded callback page (see below). Omit for the default direct-to-loopback redirect. |
| `allowedLoopbackPorts` | — | Optional hardening: `number[]` or `{ min, max }`. Restricts which loopback port the server will redirect to. |
| `disableOriginOverride` | `false` | Disable rewriting the request origin from the `desktop-origin` header. |

By **default** the server redirects the browser straight to the desktop
loopback. No web callback page is involved.

## Electrobun (desktop)

`electrobunDesktop` is a standard Better Auth client plugin. Use it with
`createAuthClient` in the Bun **main** process, pass `createBunRPC()` to your
`BrowserWindow`, and call `setupMain()`.

`storage` is **required** — pass `keychainStorage()` (Bun.secrets) or your own
keychain-backed `Storage`. The package never picks a default, so it can't
silently land on a runtime-inappropriate one.

```ts
// desktop/bun/auth.ts
import { createAuthClient } from "better-auth/client";
import {
  electrobunDesktop,
  keychainStorage,
} from "@soorya-u/better-auth-desktop/electrobun";

export const authClient = createAuthClient({
  baseURL: process.env.SERVER_URL!,
  plugins: [
    electrobunDesktop({
      clientID: "my-desktop-app",
      storage: await keychainStorage(),
      // loopbackPort: 51789,  // optional; omit to bind 127.0.0.1:0 (OS-assigned)
    }),
  ],
});

// Bun-side RPC the WebView calls; pass to `new BrowserWindow({ rpc })`.
export const authBunRpc = authClient.createBunRPC();
```

```ts
// desktop/bun/index.ts
import { BrowserWindow } from "electrobun/bun";
import { authClient, authBunRpc } from "./auth";

new BrowserWindow({ title: "My App", url, rpc: authBunRpc });
await authClient.setupMain();
```

### Renderer (WebView)

```ts
// renderer entry
import { defineAuthWebviewRPC } from "@soorya-u/better-auth-desktop/rpc/webview";

export const auth = defineAuthWebviewRPC();

auth.onAuthenticated((user) => navigate("/app"));
await auth.requestAuth({ provider: "github" });
```

The bridge exposes `requestAuth`, `getUser`, `signOut`, `getUserImage`, and the
`onAuthenticated` / `onUserUpdated` / `onAuthError` subscriptions.

No `urlSchemes` / `protocol` registration is needed in `electrobun.config.ts`.

## Electron (desktop)

The Electron adapter shares the same core; it pulls in **no** Electrobun code.
`storage` is **required**. The package ships `electronStorage()` — persistent
via [`electron-store`](https://github.com/sindresorhus/electron-store) (install
it: `bun add electron-store`) with values encrypted by Electron `safeStorage`
(OS keychain) when available — or you can supply your own `Storage`.

```ts
// main process
import { createAuthClient } from "better-auth/client";
import {
  electronDesktop,
  electronStorage,
} from "@soorya-u/better-auth-desktop/electron";

const authClient = createAuthClient({
  baseURL: process.env.SERVER_URL!,
  plugins: [
    electronDesktop({
      clientID: "my-desktop-app",
      getWindow: () => mainWindow,
      storage: await electronStorage(),
    }),
  ],
});
await authClient.setupMain();
```

The renderer talks to it over IPC; the channel names are exported as
`ELECTRON_AUTH_CHANNELS` from `@soorya-u/better-auth-desktop/electron`.

## Optional: branded web callback page

If you set `webCallbackUrl` on the server plugin, `oauth-complete` redirects the
browser to your page (`#token=…&loopback=…`) instead of straight to the
loopback. Your page calls `forwardToDesktop()`, which performs the top-level
navigation to `127.0.0.1` — still no CORS / PNA / mixed-content.

It's available both as a standalone function and as a Better Auth client plugin:

```ts
// standalone
import { forwardToDesktop } from "@soorya-u/better-auth-desktop/web";
forwardToDesktop(); // safe no-op outside a desktop sign-in

// or as a plugin
import { webDesktop } from "@soorya-u/better-auth-desktop/web";
const authClient = createAuthClient({ plugins: [webDesktop()] });
authClient.forwardToDesktop();
```

### Customizing the loopback success page

By default the loopback serves a minimal "you can close this tab" page. Override
it via `loopbackSuccess` on the desktop plugin — a string is used as the HTML
body, or `{ redirectTo }` bounces the browser to your own page:

```ts
electrobunDesktop({
  storage: await keychainStorage(),
  loopbackSuccess: { redirectTo: "https://app.example.com/signed-in" },
});
```

## Custom adapters

`@soorya-u/better-auth-desktop/core` exposes the framework-agnostic pieces —
the `DesktopAdapter` interface, `startAuthFlow`, `exchangeToken`, the loopback
helpers, and `desktopClient` — so you can target another runtime. An adapter
only has to:

```ts
type DesktopAdapter = {
  openExternal(url: string): void | Promise<void>;
  serveLoopback(
    onRequest: (req: LoopbackRequest) => Promise<LoopbackResponse>,
    opts?: { port?: number },
  ): Promise<{ port: number; close(): void }>;
  notifyRenderer(event: AuthEvent): void;
  storage: Storage;
};
```

## Exports

| Subpath | Purpose |
| --- | --- |
| `@soorya-u/better-auth-desktop` | re-exports `core` (types & utilities) |
| `@soorya-u/better-auth-desktop/server` | `betterAuthDesktop()` server plugin |
| `@soorya-u/better-auth-desktop/electrobun` | `electrobunDesktop()` plugin + `keychainStorage()` (Bun main process) |
| `@soorya-u/better-auth-desktop/rpc/webview` | `defineAuthWebviewRPC()` (Electrobun renderer) |
| `@soorya-u/better-auth-desktop/electron` | `electronDesktop()` plugin + `electronStorage()` (Electron main process) |
| `@soorya-u/better-auth-desktop/web` | `forwardToDesktop()` + `webDesktop()` plugin (optional branded page) |
| `@soorya-u/better-auth-desktop/client` | `desktopClient()` Better Auth client plugin |
| `@soorya-u/better-auth-desktop/core` | shared types & utilities for custom adapters |

## Security notes

- The loopback binds `127.0.0.1` only and is unreachable off-box.
- The token in the loopback URL is a one-time, short-TTL, PKCE-bound code; the
  verifier never leaves the desktop, so interception/replay is useless.
- The nonce stops a different local app from consuming the redirect.
- The loopback closes immediately after a successful exchange (or on timeout).

## License

MIT
