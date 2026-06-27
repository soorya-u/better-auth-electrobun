import { defineErrorCodes } from "better-auth";

export const DESKTOP_ERROR_CODES = defineErrorCodes({
	INVALID_CLIENT_ID: "Invalid client ID",
	INVALID_TOKEN: "Invalid or expired token.",
	STATE_MISMATCH: "state mismatch",
	MISSING_CODE_CHALLENGE: "missing code challenge",
	INVALID_CODE_VERIFIER: "Invalid code verifier",
	MISSING_STATE: "state is required",
	MISSING_PKCE: "pkce is required",
	INVALID_PKCE_METHOD: "PKCE method must be S256",
	INVALID_LOOPBACK_URL: "callbackURL must be a http://127.0.0.1 loopback URL",
});
