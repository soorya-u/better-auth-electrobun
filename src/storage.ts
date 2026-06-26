import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import type { Storage } from "./types/client";

export type StorageOptions = {
	service?: string | undefined;
	account?: string | undefined;
};

let workerCache: { worker: Worker; mainPort: MessagePort } | null = null;

function getWorker() {
	if (!workerCache) {
		const { port1: mainPort, port2: workerPort } = new MessageChannel();
		mainPort.unref();
		workerPort.unref();
		const worker = new Worker(
			new URL("./worker.ts", import.meta.url).href,
		);
		worker.postMessage({ op: "init", port: workerPort }, [workerPort]);
		worker.unref();
		workerCache = { worker, mainPort };
	}
	return workerCache;
}

function fetchRaw(opts: { service: string; name: string }): string | null {
	const { worker, mainPort } = getWorker();
	const semaphore = new Int32Array(
		new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
	);
	worker.postMessage({ op: "get", opts, semaphore });
	Atomics.wait(semaphore, 0, 0);
	const msg = receiveMessageOnPort(mainPort);
	return (
		(msg?.message as { result: string | null } | undefined)?.result ?? null
	);
}

function persistRaw(
	opts: { service: string; name: string },
	value: string,
): void {
	getWorker().worker.postMessage({ op: "set", opts, value });
}

export function storage(opts: StorageOptions = {}): Storage {
	const { service = "better-auth-electrobun", account = "session" } = opts;
	const keychainOpts = { service, name: account };

	let cache: Record<string, unknown> = {};
	try {
		const raw = fetchRaw(keychainOpts);
		if (raw) cache = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		cache = {};
	}

	return {
		getItem: (name) => {
			const v = cache[name];
			return v === undefined ? null : v;
		},
		setItem: (name, value) => {
			cache[name] = value;
			persistRaw(keychainOpts, JSON.stringify(cache));
		},
	};
}

export function storageForTests(): Storage {
	return storage({ service: `better-auth-electrobun-test-${process.pid}` });
}
