import type { User } from "@better-auth/core/db";
import { base64 } from "@better-auth/utils/base64";
import type { ElectrobunClientOptions } from "./types/client";

const DEFAULT_MAX_BYTES = 1024 * 1024 * 5; // 5MB

export type FetchUserImageResult = {
	bytes: Uint8Array;
	mimeType: string;
};

export async function fetchUserImage(
	baseURL: string | undefined,
	url: string,
): Promise<FetchUserImageResult | null> {
	// Handle data URLs
	const decoded = await decodeDataImageUrl(url);
	if (decoded) {
		return { bytes: decoded.bytes, mimeType: decoded.mimeType };
	}

	// Validate and resolve URL
	let resolvedUrl: string;
	try {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			if (!baseURL) return null;
			const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
			const relative = url.startsWith("/") ? url.slice(1) : url;
			parsed = new URL(relative, base);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		resolvedUrl = parsed.href;
	} catch {
		return null;
	}

	// Uses Bun's global `fetch` (Electron's `net.fetch` equivalent).
	const response = await fetch(resolvedUrl, {
		method: "GET",
		headers: { accept: "image/*" },
	});

	if (!response.ok) return null;

	const contentType = response.headers.get("content-type");
	if (
		!contentType?.startsWith("image/") ||
		contentType.startsWith("image/svg")
	) {
		return null;
	}

	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > DEFAULT_MAX_BYTES) {
		return null;
	}

	const buf = await response.arrayBuffer();
	const bytes = new Uint8Array(buf);
	if (bytes.byteLength > DEFAULT_MAX_BYTES) return null;

	const mimeType = contentType.split(";")[0]?.trim() || "image/png";
	return { bytes, mimeType };
}

/**
 * Leaves the user object's `image` as-is. Electrobun has no custom-protocol
 * handler equivalent to Electron's `user-image://` scheme, so we do not
 * rewrite URLs here. (An optional RPC-based image proxy can be layered on
 * later by the consumer — see the roadmap in the plan.)
 */
export function normalizeUserOutput<U extends User & Record<string, any>>(
	user: U,
	_options?: ElectrobunClientOptions | undefined,
): U {
	return { ...user };
}

async function decodeDataImageUrl(url: string) {
	const maxBase64Size = Math.ceil((DEFAULT_MAX_BYTES * 4) / 3);
	const lower = url.toLowerCase();
	if (!lower.startsWith("data:image/") || lower.startsWith("data:image/svg")) {
		return null;
	}
	const base64Marker = ";base64,";
	const markerIdx = lower.indexOf(base64Marker);
	if (markerIdx === -1) return null;
	const mimeType = url.substring("data:".length, markerIdx);
	const payload = url.substring(markerIdx + base64Marker.length);
	if (!payload || payload.length > maxBase64Size) return null;
	try {
		const bytes = base64.decode(payload);
		if (!detectImageType(bytes)) return null;
		return { bytes, mimeType };
	} catch {
		return null;
	}
}

type SupportedImageType =
	| "image/png"
	| "image/jpg"
	| "image/gif"
	| "image/bmp"
	| "image/webp"
	| "image/avif"
	| "image/heic"
	| "image/heif"
	| "image/tiff"
	| "image/x-icon";

function detectImageType(bytes: Uint8Array): SupportedImageType | null {
	if (bytes.length < 12) return null;

	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}

	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpg";
	}

	if (
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}

	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}

	if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
		return "image/bmp";
	}

	if (
		(bytes[0] === 0x49 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x2a &&
			bytes[3] === 0x00) ||
		(bytes[0] === 0x4d &&
			bytes[1] === 0x4d &&
			bytes[2] === 0x00 &&
			bytes[3] === 0x2a)
	) {
		return "image/tiff";
	}

	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x00 &&
		bytes[2] === 0x01 &&
		bytes[3] === 0x00
	) {
		return "image/x-icon";
	}

	// avif, heic, heif
	if (bytes.length < 16) return null;

	const fTyp = String.fromCharCode(...bytes.slice(4, 8));
	if (fTyp !== "ftyp") return null;

	const brand = String.fromCharCode(...bytes.slice(8, 12));

	if (brand === "avif" || brand === "heic" || brand === "heif") {
		return `image/${brand}` as SupportedImageType;
	}
	if (
		brand === "heix" ||
		brand === "hevc" ||
		brand === "mif1" ||
		brand === "msf1"
	) {
		return "image/heic";
	}

	return null;
}
