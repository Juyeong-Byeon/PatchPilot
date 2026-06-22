import { z } from "zod";
import type { TicketSnapshotInput } from "./types.js";

const prioritySchema = z.enum(["Low", "Normal", "High"]);

export class InvalidLarkTicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLarkTicketError";
  }
}

export function isInvalidLarkTicketError(error: unknown): error is InvalidLarkTicketError {
  return error instanceof InvalidLarkTicketError;
}

function parsePriority(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "Important") return "High";
  const result = prioritySchema.safeParse(normalized);
  if (!result.success) throw new InvalidLarkTicketError("Invalid Lark field: Priority");
  return result.data;
}

function requiredString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidLarkTicketError(`Missing required Lark field: ${name}`);
  }
  return value.trim();
}

export function parseLarkTicket(
  larkRecordId: string,
  triggerVersion: string,
  fields: Record<string, unknown>,
): TicketSnapshotInput {
  return {
    larkRecordId,
    triggerVersion,
    title: requiredString(fields, "Title"),
    description: requiredString(fields, "Description"),
    definitionOfDone: requiredString(fields, "Definition of Done"),
    repository: requiredString(fields, "Repository"),
    targetBranch: requiredString(fields, "Target Branch"),
    priority: parsePriority(fields.Priority),
    status: requiredString(fields, "Status"),
    agentRunRequested: fields["Agent Run Requested"] === true,
    rawFields: fields,
  };
}

export function shouldCreateJobFromTicket(ticket: TicketSnapshotInput): boolean {
  return ticket.status === "Progress" && ticket.agentRunRequested === true;
}
