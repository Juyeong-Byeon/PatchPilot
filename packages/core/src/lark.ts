import { z } from "zod";
import type { TicketSnapshotInput } from "./types.js";

const prioritySchema = z.enum(["Low", "Normal", "High"]);

function requiredString(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required Lark field: ${name}`);
  }
  return value.trim();
}

export function parseLarkTicket(
  larkRecordId: string,
  triggerVersion: string,
  fields: Record<string, unknown>
): TicketSnapshotInput {
  return {
    larkRecordId,
    triggerVersion,
    title: requiredString(fields, "Title"),
    description: requiredString(fields, "Description"),
    definitionOfDone: requiredString(fields, "Definition of Done"),
    repository: requiredString(fields, "Repository"),
    targetBranch: requiredString(fields, "Target Branch"),
    priority: prioritySchema.parse(fields.Priority),
    status: requiredString(fields, "Status"),
    agentRunRequested: fields["Agent Run Requested"] === true,
    rawFields: fields
  };
}

export function shouldCreateJobFromTicket(ticket: TicketSnapshotInput): boolean {
  return ticket.status === "Progress" && ticket.agentRunRequested === true;
}
