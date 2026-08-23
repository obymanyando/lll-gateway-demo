import Fastify from "fastify";
import { env } from "./env";
import { providers } from "./providers/registry";
import { registerAdminRoutes } from "./routes/admin";
import { registerChatRoute } from "./routes/chat";
import { registerDashboardRoute } from "./routes/dashboard";
import { registerRagRoute } from "./routes/rag";

const app = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
  },
});

app.get("/health", async () => ({
  status: "ok",
  providers: [...providers.keys()],
}));

registerChatRoute(app);
registerAdminRoutes(app);
registerRagRoute(app);
registerDashboardRoute(app);

async function main(): Promise<void> {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`providers configured: ${[...providers.keys()].join(", ")}`);
  } catch (cause) {
    app.log.error(cause);
    process.exit(1);
  }
}

void main();
