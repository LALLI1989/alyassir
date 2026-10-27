import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ChangeSignal, ChangeTopic } from "@alyassir/shared";

/** Returns the user id if the token and its session are valid, else null. */
export type SocketAuthenticator = (token: string) => Promise<string | null>;

/**
 * Realtime "something changed" signals (SPEC 3.2, 4.10). The server never pushes data:
 * clients refetch. After a reconnection, clients refetch everything they show.
 */
@Injectable()
export class RealtimeService implements OnApplicationShutdown {
  private readonly logger = new Logger("Realtime");
  private io: Server | null = null;

  attach(httpServer: HttpServer, authenticate: SocketAuthenticator, corsOrigin?: string): void {
    this.io = new Server(httpServer, {
      path: "/socket.io",
      serveClient: false,
      transports: ["websocket"],
      pingInterval: 20_000,
      pingTimeout: 20_000,
      ...(corsOrigin ? { cors: { origin: corsOrigin } } : {}),
    });
    this.io.use((socket: Socket, next) => {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== "string") return next(new Error("UNAUTHENTICATED"));
      authenticate(token).then(
        (userId) => {
          if (!userId) return next(new Error("UNAUTHENTICATED"));
          socket.data.userId = userId;
          next();
        },
        () => next(new Error("UNAUTHENTICATED")),
      );
    });
    this.io.on("connection", (socket: Socket) => {
      void socket.join(`user:${String(socket.data.userId)}`);
    });
    this.logger.log("Realtime ready");
  }

  notifyAll(topic: ChangeTopic): void {
    this.io?.emit("changed", { topic } satisfies ChangeSignal);
  }

  notifyUsers(userIds: Iterable<string>, topic: ChangeTopic): void {
    if (!this.io) return;
    const rooms = [...new Set(userIds)].map((id) => `user:${id}`);
    if (rooms.length) this.io.to(rooms).emit("changed", { topic } satisfies ChangeSignal);
  }

  /** Cuts a user's live connections at once (account disabled, password reset). */
  disconnectUser(userId: string): void {
    this.io?.in(`user:${userId}`).disconnectSockets(true);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.io) return resolve();
      // Only close socket.io itself; the HTTP server belongs to Fastify.
      this.io.disconnectSockets(true);
      this.io.removeAllListeners();
      resolve();
    });
    this.io = null;
  }
}
