// Small shared config surface: a few environment-driven knobs with safe
// defaults, resolved in one place so nothing hardcodes a port/host/path
// that a scratch or test instance would need to override. Deliberately
// tiny for build step 1 — grows as later build steps (subjects, sessions,
// scheduler) need their own knobs.

export const PORT = Number(process.env.ATHENA_PORT) || 4417;

// localhost only (SPEC.md section 2: "Binds to localhost only") — this is
// a single-user local app, never meant to be reachable from the network.
export const HOST = process.env.ATHENA_HOST || "127.0.0.1";
