export type { ElectronSharedOptions } from "@better-auth/electron";

type BaseOptions = {
  /**
   * Client ID to use for identifying the Electrobun client during authorization.
   * @default "electrobun"
   */
  clientID?: string;
  /**
   * Duration (in seconds) for which the authorization code is valid.
   * @default 300
   */
  codeExpiresIn?: number;
  /**
   * Disable electron-origin header rewriting for CORS.
   * @default false
   */
  disableOriginOverride?: boolean;
};

type CookieFlowOptions = BaseOptions & {
  origin: "same"
  cookies: {
    /**
     * Cookie name prefix.
     * @default "better-auth"
     */
    cookiePrefix?: string;
    /**
     * Duration (in seconds) for which the redirect cookie is valid.
     * @default 120
     */
    redirectCookieExpiresIn?: number;
  };
};

type CrossDomainOptions = BaseOptions & {
  origin: "cross"
  /**
   * When set, the OAuth callback redirects to the web app with the token in
   * the URL fragment instead of returning JSON + setting a same-domain cookie.
   * Use this when your server and web app are on different origins.
   */
  callback: {
    /**
     * The web app URL to redirect to after OAuth completes.
     * e.g. "https://example.com/auth/callback"
     */
    url: string;
    /**
     * The hash key for the redirect token.
     * @default "token"
     */
    hashKey?: string;
  };
};

export type ElectrobunServerOptions = CookieFlowOptions | CrossDomainOptions;
