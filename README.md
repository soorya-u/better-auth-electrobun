# @soorya-u/better-auth-electrobun

Integrate [Better Auth](https://better-auth.com) with [Electrobun](https://electrobun.dev) desktop applications.

## Installation

### Configure a Better Auth front- & back-end

Before integrating with Electrobun, ensure you have a Better Auth server and client set up. To get started, check out the [installation](https://better-auth.com/docs/installation) guide for setting up Better Auth.

### Install the required packages

```bash
bun add better-auth @soorya-u/better-auth-electrobun
```

### Add the Electrobun plugin to your Better Auth server

```ts
// web/lib/auth.ts
import { betterAuth } from "better-auth";
import { electrobun } from "@soorya-u/better-auth-electrobun";

export const auth = betterAuth({
  plugins: [electrobun()],
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});
```

### Add the proxy plugin to your web client

On your sign-in frontend, add the proxy plugin to handle redirects back into the Electrobun app.

```ts
// web/lib/auth-client.ts
import { createAuthClient } from "better-auth/client";
import { electrobunProxyClient } from "@soorya-u/better-auth-electrobun";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000",
  plugins: [
    electrobunProxyClient({
      protocol: {
        scheme: "com.example.app",
      },
    }),
  ],
});
```

### Initialize the Electrobun client

In your Electrobun Bun process, create the auth client using `electrobunClient`.

```ts
// app/lib/auth-client.ts
import { createAuthClient } from "better-auth/client";
import { electrobunClient } from "@soorya-u/better-auth-electrobun";
import { storage } from "@soorya-u/better-auth-electrobun/storage";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000",
  plugins: [
    electrobunClient({
      signInURL: "https://app.example.com/sign-in",
      protocol: {
        scheme: "com.example.app",
      },
      storage: storage(),
    }),
  ],
});
```

The built-in `storage()` helper stores session data in the OS keychain via `Bun.secrets` (macOS Keychain, Windows Credential Manager, Linux libsecret). You can also provide your own storage:

```ts
electrobunClient({
  // ...
  storage: {
    getItem: (key) => myStore.get(key) ?? null,
    setItem: (key, value) => myStore.set(key, value),
  },
});
```

### Register the deep link scheme

Register your custom protocol scheme in your Electrobun app configuration so the OS routes deep links back to your app.

```ts
// electroapp.config.ts
import { defineConfig } from "electrobun/config";

export default defineConfig({
  app: {
    protocols: [{ scheme: "com.example.app" }],
  },
});
```

### Scheme and trusted origins

The plugin uses deep links to redirect users back to your app after authentication. Add your app's protocol scheme to `trustedOrigins` on your Better Auth server.

```ts
// web/lib/auth.ts
export const auth = betterAuth({
  trustedOrigins: ["com.example.app:/"],
  // ...
});
```

The scheme should follow [reverse domain name notation](https://datatracker.ietf.org/doc/html/rfc8252#section-7.1) to ensure uniqueness (e.g. `com.example.app`).

### Setup the main process (Bun side)

In your Electrobun Bun process, call `setupMain()` from the auth client. This registers the deep-link handler and sets up the RPC bridge that connects the Bun process to your webview.

```ts
// app/bun-main.ts
import { BrowserView, BrowserWindow } from "electrobun/bun";
import { authClient } from "./lib/auth-client";

const win = new BrowserWindow({ /* ... */ });
const view = new BrowserView({ /* ... */ });

await authClient.setupMain({
  getWebview: () => view,
});
```

### Setup the webview (renderer side)

In your webview entry point, call `defineAuthWebviewRPC()`. This creates the typed RPC bridge over Electrobun's transport and returns an `auth` object you can use anywhere in your webview.

```ts
// app/webview/main.ts
import { defineAuthWebviewRPC } from "@soorya-u/better-auth-electrobun/rpc/webview";

export const auth = defineAuthWebviewRPC();
```

## Usage

### Handling authorization in the browser

On your web sign-in page, call `ensureElectronRedirect()` to redirect users back to the Electrobun app after they authenticate. Also pass any PKCE and state query parameters through to the sign-in method.

The following example uses React, but the same logic applies to any framework:

```tsx
// web/pages/sign-in.tsx
import { useEffect, use } from "react";
import { authClient } from "../lib/auth-client";

function SignIn({
  searchParams,
}: {
  searchParams: Promise<{
    client_id?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }>;
}) {
  const query = use(searchParams);

  useEffect(() => {
    const id = authClient.ensureElectronRedirect();
    return () => clearTimeout(id);
  }, []);

  return (
    <button
      onClick={() =>
        authClient.signIn.social({
          provider: "google",
          fetchOptions: { query }, // preserve PKCE/state params
        })
      }
    >
      Sign in with Google
    </button>
  );
}
```

### Handling authentication in the webview

Use the `auth` object returned by `defineAuthWebviewRPC()` to trigger sign-in and listen for auth events from the Bun process.

```ts
// app/webview/main.ts
import { auth } from "./main";

// Listen for authentication events
const unsubscribeAuth = auth.onAuthenticated((user) => {
  console.log("Authenticated:", user);
});

const unsubscribeError = auth.onAuthError((ctx) => {
  console.error("Auth error:", ctx.error);
});

// Trigger sign-in — opens the system browser
await auth.requestAuth();

// Or sign in directly with a social provider
await auth.requestAuth({ provider: "google" });

// Cleanup
unsubscribeAuth();
unsubscribeError();
```

You can also call `requestAuth()` directly from the Bun process:

```ts
// app/bun-main.ts
import { authClient } from "./lib/auth-client";

authClient.requestAuth();
```

### Sign out

```ts
// From the webview
await auth.signOut();
```

### Subscribing to user updates

```ts
// app/webview/main.ts
const unsubscribe = auth.onUserUpdated((user) => {
  if (user) {
    console.log("User updated:", user.name);
  } else {
    console.log("User signed out");
  }
});

unsubscribe();
```

### Handling errors

```ts
// app/webview/main.ts
const unsubscribe = auth.onAuthError((ctx) => {
  console.error(`Auth error on ${ctx.path}:`, ctx.error);
});

unsubscribe();
```

### Manual token exchange

In some environments, deep link redirects may not work reliably (e.g. certain Linux desktop environments or sandboxed browsers). As a fallback, users can copy the authorization code from the web UI and paste it into the app.

**Front-end** — display the code after authentication:

```tsx
// web/pages/sign-in.tsx
import { useEffect } from "react";
import { authClient } from "../lib/auth-client";

function Providers({ children }) {
  useEffect(() => {
    const code = authClient.electron.getAuthorizationCode();
    if (code) {
      // Show the code to the user so they can copy it
      console.log("Authorization code:", code);
    }
  }, []);

  return <>{children}</>;
}
```

The code is also returned after a successful sign-in when using `transferUser`:

```ts
const { data } = await authClient.electron.transferUser({
  fetchOptions: { query: params },
});

if (data?.electron_authorization_code) {
  // Show the code to the user
}
```

**Webview** — provide an input for the user to paste the code:

```tsx
// app/webview/components/ManualCodeEntry.tsx
import { auth } from "../main";

function ManualCodeEntry() {
  return (
    <input
      type="text"
      placeholder="Paste code here"
      maxLength={32}
      onChange={(e) => {
        if (e.target.value.length === 32) {
          // requestAuth() must have been called before authenticate()
          auth.authenticate({ token: e.target.value });
        }
      }}
    />
  );
}
```

The `authenticate` bridge exchanges the code in the Bun process using the stored PKCE verifier. On success, `onAuthenticated` fires in the webview.

> The authorization code is a short-lived 32-character string. `requestAuth()` must be called before `authenticate()` — it generates the PKCE verifier and state that the exchange relies on.

### User image proxy

To avoid CSP issues, the plugin proxies user avatar images through `fetchUserImage`, encoding them as data URLs before sending to the webview. Use the image URL returned by the auth session directly:

```tsx
// app/webview/components/Avatar.tsx
<img src={user.image} alt="Avatar" />
```

The Bun RPC handler resolves the URL, fetches the image, and returns a `data:image/...;base64,...` string safe for webview rendering.

## Options

### `electrobunClient` options

#### `signInURL`

The URL of your web sign-in page. The system browser opens this URL when `requestAuth()` is called.

```ts
electrobunClient({ signInURL: "https://app.example.com/sign-in" });
```

#### `protocol`

Your app's custom URL scheme, used for deep-link callbacks. Should follow [reverse domain name notation](https://datatracker.ietf.org/doc/html/rfc8252#section-7.1).

```ts
electrobunClient({ protocol: "com.example.app" });
// or
electrobunClient({ protocol: { scheme: "com.example.app" } });
```

#### `storage`

Storage for session and cookie data. Use the built-in `storage()` helper (OS keychain via `Bun.secrets`) or provide your own:

```ts
import { storage } from "@soorya-u/better-auth-electrobun/storage";

// Default — stores under service "better-auth-electrobun", account "session"
electrobunClient({ storage: storage() });

// Custom service/account name in the OS keychain
electrobunClient({ storage: storage({ service: "my-app", account: "auth" }) });
```

#### `callbackPath?`

The path the deep link redirects to after authentication. Defaults to `/auth/callback`. Must match the path configured in `electrobunProxyClient`.

```ts
electrobunClient({ callbackPath: "/auth/callback" });
```

#### `storagePrefix?`

Prefix for storage keys. Defaults to `better-auth`.

#### `cookiePrefix?`

Prefix(es) for server cookie names to filter. Defaults to `better-auth`. Used to identify which cookies belong to Better Auth and avoid infinite re-fetching when third-party cookies are set.

```ts
electrobunClient({ cookiePrefix: "better-auth" });
// or multiple prefixes
electrobunClient({ cookiePrefix: ["better-auth", "my-app"] });
```

#### `clientID?`

The client ID identifying the Electrobun client during authorization. Defaults to `electrobun`. Must match the `clientID` configured in the server plugin and proxy client.

#### `sanitizeUser?`

Strip sensitive fields from the user object before it is sent to the webview via RPC.

```ts
electrobunClient({
  sanitizeUser: (user) => {
    const { sensitiveField, ...rest } = user;
    return rest;
  },
});
```

#### `sessionPartition?`

The Electrobun session partition to mirror cookies into. Defaults to `persist:auth`.

#### `disableCache?`

Disable local session caching. Defaults to `false`.

```ts
electrobunClient({ disableCache: true });
```
