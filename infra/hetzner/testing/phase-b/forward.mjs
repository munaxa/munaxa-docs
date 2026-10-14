// Phase B (ADR-0026 §10): makes the stack's proxy answer at http://localhost:8080 inside the browser
// container, so the browser uses the origin the stack is configured for (CORS_ORIGINS, WEB_BASE_URL,
// STORAGE_PUBLIC_URL) — cookies, CORS and the secure context Web Crypto needs then behave exactly as
// they do for a person on the host. A plain TCP relay; nothing is read or changed on the way.
import net from 'node:net';

/** Starts the relay; resolves once it is listening, with a function that stops it. */
export function forwardLocalhost(port, target) {
  const { hostname, port: targetPort } = new URL(target);
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(targetPort || 80), hostname);
    sockets.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve(
        () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      ),
    );
  });
}
