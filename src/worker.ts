declare var self: Worker;

type InitMessage = { op: "init"; port: MessagePort };
type GetMessage = {
  op: "get";
  opts: { service: string; name: string };
  semaphore: Int32Array;
};
type SetMessage = {
  op: "set";
  opts: { service: string; name: string };
  value: string;
};

let workerPort: MessagePort;

self.onmessage = async (
  event: MessageEvent<InitMessage | GetMessage | SetMessage>,
) => {
  const msg = event.data;
  if (msg.op === "init") {
    workerPort = msg.port;
  } else if (msg.op === "get") {
    try {
      const result = await Bun.secrets.get(msg.opts);
      workerPort.postMessage({ result: result ?? null });
    } catch {
      workerPort.postMessage({ result: null });
    } finally {
      Atomics.store(msg.semaphore, 0, 1);
      Atomics.notify(msg.semaphore, 0, 1);
    }
  } else if (msg.op === "set") {
    try {
      await Bun.secrets.set({ ...msg.opts, value: msg.value });
    } catch {}
  }
};
