import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Container } from "@/container.js";
import { HealthService } from "@/modules/health/health.service.js";

/**
 * Liveness and readiness. Both fully schema'd, as the REST convention requires:
 * a response schema drives serialization and the generated docs, so there are
 * no un-schema'd 200s here either.
 */

const LivenessResponse = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
});

const DependencyReport = z.object({
  name: z.string(),
  status: z.enum(["up", "down"]),
  durationMs: z.number(),
  error: z.string().optional(),
  // Present only on dependencies whose absence degrades function rather than
  // stopping it, so a `down` that left the verdict `ready` explains itself.
  optional: z.boolean().optional(),
});

const ReadinessResponse = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.array(DependencyReport),
});

export function healthRoutes(container: Container) {
  const service = new HealthService(container.healthChecks);

  return async function register(app: FastifyInstance): Promise<void> {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.route({
      method: "GET",
      url: "/health",
      schema: {
        description:
          "Liveness. Answers 200 whenever the process is running — it deliberately " +
          "does not touch dependencies, so a failing database never triggers a restart loop.",
        response: { 200: LivenessResponse },
      },
      handler: () => ({
        status: "ok" as const,
        uptimeSeconds: Math.round(process.uptime()),
      }),
    });

    typed.route({
      method: "GET",
      url: "/ready",
      schema: {
        description:
          "Readiness. Runs every registered dependency probe and answers 503 " +
          "when any is down, so a load balancer stops sending traffic here.",
        response: { 200: ReadinessResponse, 503: ReadinessResponse },
      },
      handler: async (_request, reply) => {
        const report = await service.readiness();
        return reply.code(report.status === "ready" ? 200 : 503).send(report);
      },
    });
  };
}
