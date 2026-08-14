// Chrome exposes promise-returning `chrome.*` under MV3; Firefox exposes
// promise-returning `browser.*`. Resolve once so no other module has to care.
export const api = globalThis.browser ?? globalThis.chrome;
