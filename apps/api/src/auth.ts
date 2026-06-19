import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export function assertAdminToken(request: FastifyRequest, expectedToken: string): void {
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    const error = new Error("Unauthorized");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}

export function assertLarkWebhookSecret(request: FastifyRequest, expectedSecret: string): void {
  const headerValue = request.headers["x-lark-webhook-secret"];
  const providedSecret = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
    const error = new Error("Invalid Lark webhook secret");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
