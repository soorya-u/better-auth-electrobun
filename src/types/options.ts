/**
 * Electrobun-shared server options are identical to the Electron ones because
 * the server plugin is reused verbatim from `@better-auth/electron`. This
 * file re-exports them so consumers of `@soorya-u/better-auth-electrobun`
 * have a single import surface.
 */
export type {
	ElectronOptions,
	ElectronSharedOptions,
} from "@better-auth/electron";
