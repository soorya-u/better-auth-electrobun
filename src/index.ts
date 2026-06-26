export type {
	ElectronOptions,
	ElectronSharedOptions,
} from "@better-auth/electron";
export { electron, electron as electrobun } from "@better-auth/electron";
export {
	electronProxyClient,
	electronProxyClient as electrobunProxyClient,
} from "@better-auth/electron/proxy";

export { electrobunClient } from "./client";
export type { AuthBunRPCContext, AuthSender } from "./rpc/bun";
export { authRequestHandlers, createAuthBunRPC } from "./rpc/bun";
export type {
	AuthBridges,
	AuthBunRequests,
	AuthWebviewMessages,
	ElectrobunAuthRPC,
} from "./rpc/schema";
export { handleDeepLink } from "./setup";
export { storage } from "./storage";
export type * from "./types/auth";
export type * from "./types/client";
export type { ElectrobunClientOptions, Storage } from "./types/client";
export { normalizeUserOutput } from "./user";
export { PACKAGE_VERSION } from "./version";
