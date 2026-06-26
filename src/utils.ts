import type { ElectrobunClientOptions } from "./client";

export function parseProtocolScheme(
	protocolOption: ElectrobunClientOptions["protocol"],
) {
	if (typeof protocolOption === "string") {
		return {
			scheme: protocolOption,
		};
	}

	return {
		scheme: protocolOption.scheme,
	};
}

export function getChannelPrefixWithDelimiter(ns = "better-auth") {
	return ns.length > 0 ? `${ns}:` : ns;
}
