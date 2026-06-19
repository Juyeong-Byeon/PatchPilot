import type { FastifyRequest } from "fastify";

export function assertAdminToken(request: FastifyRequest, expectedToken: string): void {
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}
