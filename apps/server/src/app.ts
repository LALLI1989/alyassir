import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ServerConfig } from "./config";
import { DatabaseService } from "./database.service";
import { HealthController } from "./health.controller";

@Module({})
class AppModule {
  static register(config: ServerConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: DatabaseService, useFactory: () => new DatabaseService(config.databaseUrl) }],
    };
  }
}

export async function createApp(config: ServerConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter(
    config.tls ? { https: { pfx: config.tls.pfx, passphrase: config.tls.passphrase } } : {},
  );
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(config), adapter, {
    logger: ["error", "warn", "log"],
  });
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  return app;
}
