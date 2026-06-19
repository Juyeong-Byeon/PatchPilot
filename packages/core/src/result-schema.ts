import { z } from "zod";

const testResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().min(1)
});

const failureSchema = z.object({
  stage: z.string().min(1),
  category: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  nextAction: z.string().min(1)
});

export const agentResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  ticketId: z.string().min(1),
  triggerVersion: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled"]),
  targetBranch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  changedFiles: z.array(z.string()).default([]),
  commits: z.array(z.object({ sha: z.string().min(1), message: z.string().min(1) })).default([]),
  tests: z.array(testResultSchema).default([]),
  review: z
    .object({
      summary: z.string().min(1),
      risks: z.array(z.string()),
      knownLimitations: z.array(z.string())
    })
    .optional(),
  pullRequestDraft: z
    .object({
      title: z.string().min(1),
      bodyPath: z.string().min(1)
    })
    .optional(),
  failure: failureSchema.nullable(),
  retryable: z.boolean()
});

export type AgentResult = z.infer<typeof agentResultSchema>;

export function parseAgentResult(value: unknown): AgentResult {
  return agentResultSchema.parse(value);
}
