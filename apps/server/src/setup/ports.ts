import { createServer } from "node:net";

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** A port is free only if nothing listens on it, on all addresses or on loopback. */
export async function isPortFree(port: number): Promise<boolean> {
  return (await canListen(port, "0.0.0.0")) && (await canListen(port, "127.0.0.1"));
}

/** First free port starting at `from`, skipping the embedded PostgreSQL port. */
export async function suggestPort(from: number, skip: number[] = []): Promise<number | null> {
  for (let port = from; port <= Math.min(from + 200, 65535); port++) {
    if (skip.includes(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return null;
}
