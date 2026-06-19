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

export const agentResultSchema = z
  .object({
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
  })
  .superRefine((result, context) => {
    if (result.status === "failed" && result.failure === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Failed results require failure details",
        path: ["failure"]
      });
    }

    if (result.status !== "completed") {
      return;
    }

    const requiredCompletedFields: Array<[unknown, string, string]> = [
      [result.targetBranch, "targetBranch", "Completed results require targetBranch"],
      [result.baseSha, "baseSha", "Completed results require baseSha"],
      [result.headSha, "headSha", "Completed results require headSha"],
      [result.review, "review", "Completed results require review"],
      [result.pullRequestDraft, "pullRequestDraft", "Completed results require pullRequestDraft"]
    ];

    for (const [value, path, message] of requiredCompletedFields) {
      if (value === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
      }
    }

    if (result.changedFiles.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results require changed files",
        path: ["changedFiles"]
      });
    }

    if (result.commits.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results require local commit evidence",
        path: ["commits"]
      });
    }

    if (result.tests.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results require test evidence",
        path: ["tests"]
      });
    }

    if (result.failure !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results must not include failure details",
        path: ["failure"]
      });
    }
  });

export type AgentResult = z.infer<typeof agentResultSchema>;

export function parseAgentResult(value: unknown): AgentResult {
  return agentResultSchema.parse(value);
}
