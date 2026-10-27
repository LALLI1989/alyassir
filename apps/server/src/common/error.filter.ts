import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";

/** Every error leaves the API as { code, ... }. Unknown errors never leak details. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("Error");

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "code" in body) {
        void reply.status(status).send(body);
        return;
      }
      const code =
        status === HttpStatus.NOT_FOUND ? "NOT_FOUND"
        : status === HttpStatus.UNAUTHORIZED ? "UNAUTHENTICATED"
        : status === HttpStatus.FORBIDDEN ? "FORBIDDEN"
        : status === HttpStatus.TOO_MANY_REQUESTS ? "RATE_LIMITED"
        : status < 500 ? "VALIDATION"
        : "INTERNAL";
      void reply.status(status).send({ code });
      return;
    }
    // Fastify errors (body too large, bad JSON, rate limit) carry a statusCode.
    const statusCode = (exception as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({ code: statusCode === 429 ? "RATE_LIMITED" : "VALIDATION" });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.message : String(exception));
    void reply.status(500).send({ code: "INTERNAL" });
  }
}
