import { z } from "zod";

const testResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().min(1),
});

const fullShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "Expected a full 40-character git SHA");

const failureSchema = z.object({
  stage: z.string().min(1),
  category: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  nextAction: z.string().min(1),
});

export const agentResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    runId: z.string().min(1),
    jobId: z.string().min(1),
    ticketId: z.string().min(1),
    triggerVersion: z.string().min(1),
    status: z.enum(["completed", "failed", "needs_input", "cancelled"]),
    // NeedsInput: the run produced NO shippable change — instead the agent asked
    // one specific question only a human can answer (ambiguous requirement /
    // missing decision). Carried here so the worker can park the job and surface
    // the question to the operator. Null on every other status.
    question: z.string().min(1).nullable().default(null),
    targetBranch: z.string().min(1).optional(),
    baseSha: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    pushSha: fullShaSchema.optional(),
    changedFiles: z.array(z.string()).default([]),
    commits: z.array(z.object({ sha: z.string().min(1), message: z.string().min(1) })).default([]),
    tests: z.array(testResultSchema).default([]),
    review: z
      .object({
        summary: z.string().min(1),
        risks: z.array(z.string()),
        knownLimitations: z.array(z.string()),
      })
      .optional(),
    pullRequestDraft: z
      .object({
        title: z.string().min(1),
        bodyPath: z.string().min(1),
      })
      .optional(),
    failure: failureSchema.nullable(),
    retryable: z.boolean(),
  })
  .superRefine((result, context) => {
    if (result.status === "failed" && result.failure === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Failed results require failure details",
        path: ["failure"],
      });
    }

    // NeedsInput is a clean stop, not a failure: it MUST carry the agent's
    // question and MUST NOT carry failure details (it parks, it does not fail).
    // No SHA/PR/test evidence is required — the run shipped nothing.
    if (result.status === "needs_input") {
      if (result.question === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "NeedsInput results require a question",
          path: ["question"],
        });
      }
      if (result.failure !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "NeedsInput results must not include failure details",
          path: ["failure"],
        });
      }
    } else if (result.question !== null) {
      // `question` is exclusive to needs_input; a stray question on any other
      // status is a contract violation (e.g. a completed run claiming it is also
      // blocked).
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only needs_input results may carry a question",
        path: ["question"],
      });
    }

    if (result.status !== "completed") {
      return;
    }

    const requiredCompletedFields: Array<[unknown, string, string]> = [
      [result.targetBranch, "targetBranch", "Completed results require targetBranch"],
      [result.baseSha, "baseSha", "Completed results require baseSha"],
      [result.headSha, "headSha", "Completed results require headSha"],
      [result.pushSha, "pushSha", "Completed results require pushSha"],
      [result.review, "review", "Completed results require review"],
      [result.pullRequestDraft, "pullRequestDraft", "Completed results require pullRequestDraft"],
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
        path: ["changedFiles"],
      });
    }

    if (result.commits.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results require local commit evidence",
        path: ["commits"],
      });
    }

    if (result.tests.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results require test evidence",
        path: ["tests"],
      });
    }

    if (result.failure !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completed results must not include failure details",
        path: ["failure"],
      });
    }
  });

export type AgentResult = z.infer<typeof agentResultSchema>;

export function parseAgentResult(value: unknown): AgentResult {
  return agentResultSchema.parse(value);
}
