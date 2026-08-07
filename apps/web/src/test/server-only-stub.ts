/**
 * A stand-in for Next's `server-only` marker.
 *
 * That package has no runtime — it exists so the compiler refuses a client import of a server
 * module. The screens reach it transitively through their server actions, so under vitest it has
 * to resolve to something, and an empty module is the honest something.
 *
 * This does not weaken the guarantee: the boundary is enforced by `next build`, which still runs.
 */
export {};
