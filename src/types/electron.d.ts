// Ambient stub so the framework-agnostic build can reference `electron` without
// taking a hard dependency. The Electron adapter casts the import to the minimal
// shapes it needs; consumers supply the real `electron` at runtime.
declare module "electron";
declare module "electron-store";
