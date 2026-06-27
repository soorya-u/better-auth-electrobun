import { generateRandomString } from "better-auth/crypto";

export const LOOPBACK_HOST = "127.0.0.1";

export type AllowedLoopbackPorts = number[] | { min: number; max: number };

export function generateNonce(): string {
	return generateRandomString(24, "a-z", "A-Z", "0-9");
}

export function buildLoopbackUrl(
	port: number,
	path: string,
	nonce: string,
): string {
	const url = new URL(`http://${LOOPBACK_HOST}:${port}`);
	url.pathname = path.startsWith("/") ? path : `/${path}`;
	url.searchParams.set("nonce", nonce);
	return url.toString();
}

// Parse a candidate loopback URL, returning it only if it is a plain-http
// 127.0.0.1 URL (never the "localhost" hostname, never https). Returns null
// for anything else so callers can reject untrusted redirect targets.
export function parseLoopbackUrl(
	raw: string,
	allowedPorts?: AllowedLoopbackPorts,
): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "http:") return null;
	if (url.hostname !== LOOPBACK_HOST) return null;
	const port = Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	if (allowedPorts && !isAllowedLoopbackPort(port, allowedPorts)) return null;
	return url;
}

export function isAllowedLoopbackPort(
	port: number,
	allowed: AllowedLoopbackPorts,
): boolean {
	if (Array.isArray(allowed)) return allowed.includes(port);
	return port >= allowed.min && port <= allowed.max;
}

// Minimal default loopback page. Parameterized so callers aren't stuck with a
// fixed copy; consumers wanting a branded page pass `loopbackSuccess` instead.
export function successPage(
	title = "Signed in",
	message = "You can close this tab and return to the app.",
): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><main><h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1><p style="margin:0;opacity:.7">${message}</p></main></body></html>`;
}
