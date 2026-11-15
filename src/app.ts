import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type Config } from "./lib/config.js";
import { Store } from "./lib/store.js";
import { cardRoutes } from "./cards/routes.js";
import { travel26Routes } from "./travel26/routes.js";
import { demoRoutes } from "./demo/routes.js";
import { mockRoutes } from "./mock/routes.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(config: Config): Promise<{ app: FastifyInstance; store: Store }> {
  const store = new Store(config.dataDir);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ ok: true, mode: config.mode }));

  await app.register(cardRoutes, { config, store });
  await app.register(travel26Routes, { config, store });
  await app.register(demoRoutes, { config, store });
  if (config.mode === "mock") await app.register(mockRoutes, { config, store });

  await app.register(fastifyStatic, { root: join(here, "..", "public"), prefix: "/" });

  return { app, store };
}
