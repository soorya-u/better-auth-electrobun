/**
 * Input options for initiating an authentication request from the renderer.
 *
 * The renderer passes a loose shape; the bun side validates it against
 * Better Auth's `signInSocial` body schema before performing the request,
 * so the wire type stays light and free of `better-auth/api` imports.
 *
 * @example
 *   { provider: "google" }
 *   { provider: "github", callbackURL: "/dashboard" }
 */
export type RequestAuthOptions = {
	/**
	 * Social provider id (e.g. "google", "github").
	 *
	 * When omitted, the bun side opens {@link ElectrobunClientOptions.signInURL}
	 * in the system browser instead of forwarding directly to the provider.
	 */
	provider?: string | undefined;
	/**
	 * Optional callback URL forwarded to the social sign-in flow.
	 */
	callbackURL?: string | undefined;
	[key: string]: unknown;
};
