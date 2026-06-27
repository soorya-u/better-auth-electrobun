import { cookieNameRegex, parseSetCookieHeader } from "better-auth/cookies";

type StoredCookie = {
	value: string;
	expires: string | null;
};

export function getSetCookie(header: string, prevCookie?: string | undefined) {
	const parsed = parseSetCookieHeader(header);
	let toSetCookie: Record<string, StoredCookie> = {};
	parsed.forEach((cookie, key) => {
		const expiresAt = cookie.expires;
		const maxAge = cookie["max-age"];
		const expires = maxAge
			? new Date(Date.now() + Number(maxAge) * 1000)
			: expiresAt
				? new Date(String(expiresAt))
				: null;
		toSetCookie[key] = {
			value: cookie.value,
			expires: expires ? expires.toISOString() : null,
		};
	});
	if (prevCookie) {
		try {
			const prevCookieParsed = JSON.parse(prevCookie);
			toSetCookie = {
				...prevCookieParsed,
				...toSetCookie,
			};
		} catch {
			//
		}
	}
	return JSON.stringify(toSetCookie);
}

export function getCookie(cookie: string) {
	let parsed = {} as Record<string, StoredCookie>;
	try {
		parsed = JSON.parse(cookie) as Record<string, StoredCookie>;
	} catch (_e) {}
	const pairs: string[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		if (value.expires && new Date(value.expires) < new Date()) continue;
		if (!cookieNameRegex.test(key)) continue;
		pairs.push(`${key}=${encodeURIComponent(value.value)}`);
	}
	return pairs.join("; ");
}

export function hasSessionCookieChanged(
	prevCookie: string | null,
	newCookie: string,
): boolean {
	if (!prevCookie) return true;
	try {
		const prev = JSON.parse(prevCookie) as Record<string, StoredCookie>;
		const next = JSON.parse(newCookie) as Record<string, StoredCookie>;
		const sessionKeys = new Set<string>();
		Object.keys(prev).forEach((key) => {
			if (key.includes("session_token") || key.includes("session_data")) {
				sessionKeys.add(key);
			}
		});
		Object.keys(next).forEach((key) => {
			if (key.includes("session_token") || key.includes("session_data")) {
				sessionKeys.add(key);
			}
		});
		for (const key of sessionKeys) {
			if (prev[key]?.value !== next[key]?.value) return true;
		}
		return false;
	} catch {
		return true;
	}
}

export function hasBetterAuthCookies(
	setCookieHeader: string,
	cookiePrefix: string | string[],
): boolean {
	const cookies = parseSetCookieHeader(setCookieHeader);
	const cookieSuffixes = ["session_token", "session_data"];
	const prefixes = Array.isArray(cookiePrefix) ? cookiePrefix : [cookiePrefix];
	for (const name of cookies.keys()) {
		const nameWithoutSecure = name.startsWith("__Secure-")
			? name.slice(9)
			: name;
		for (const prefix of prefixes) {
			if (prefix) {
				if (nameWithoutSecure.startsWith(prefix)) return true;
			} else {
				for (const suffix of cookieSuffixes) {
					if (nameWithoutSecure.endsWith(suffix)) return true;
				}
			}
		}
	}
	return false;
}
