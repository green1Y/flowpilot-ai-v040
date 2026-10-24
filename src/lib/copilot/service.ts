import { db } from "@/lib/db";
import {
  generateStructuredJson,
  generateText,
  AiNotConfiguredError,
  AiTimeoutError,
} from "@/lib/ai/structured";
import {
  generationSystemPrompt,
  generationUserMessage,
  clarificationQuestions,
  explainSystemPrompt,
  diagnoseSystemPrompt,
  addStepSystemPrompt,
  translateSystemPrompt,
  workflowSummaryText,
  type WorkflowSummary,
  type ClarifyingQuestion,
} from "./prompts";
import {
  parseModelSpec,
  parseModelFragment,
  type WorkflowSpec,
} from "./spec";
import { isCopilotBlocked, recordCopilotRequest } from "./rateLimit";

export type CopilotOp =
  | "generate"
  | "explain"
  | "diagnose"
  | "add_condition"
  | "add_delay"
  | "add_error_handling"
  | "translate";

export interface CopilotRequest {
  workspaceId: string;
  userId: string;
  op: CopilotOp;
  /** Natural-language prompt (generate / add-* ops). */
  prompt: string;
  /** Answers to clarifying questions, keyed by question id. */
  answers?: Record<string, string>;
  /** Workflow context for explain/diagnose/add/translate. Scoped to workspaceId. */
  workflowId?: string;
  /** Execution context for diagnose. Scoped via its workflow's workspace. */
  executionId?: string;
  locale?: "en" | "ar";
}

export type CopilotResult =
  | { kind: "questions"; questions: ClarifyingQuestion[] }
  | { kind: "spec"; spec: WorkflowSpec; repaired: string[]; mocked: false }
  | { kind: "text"; text: string; mocked: false };

export class CopilotRateLimitedError extends Error {
  readonly code = "COPILOT_RATE_LIMITED";
  constructor() {
    super("Too many copilot requests — please wait a few minutes and try again.");
    this.name = "CopilotRateLimitedError";
  }
}

function safeParse(raw: string | null | undefined, fallback: unknown = {}) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Load a workflow summary, tenant-scoped. Throws 404 when not in this workspace. */
export async function loadWorkflowSummary(
  workspaceId: string,
  workflowId: string
): Promise<WorkflowSummary> {
  const w = await db.workflow.findFirst({
    where: { id: workflowId, workspaceId },
    include: { nodes: true, edges: true },
  });
  if (!w) {
    const e = new Error("Workflow not found") as Error & { status?: number };
    e.status = 404;
    throw e;
  }
  return {
    name: w.name,
    status: w.status,
    nodes: w.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: safeParse(n.config, {}) as Record<string, unknown>,
    })),
    edges: w.edges.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId, label: e.label ?? "" })),
  };
}

interface FailedExecutionInfo {
  executionId: string;
  status: string;
  error: string | null;
  failedSteps: Array<{ nodeId: string; nodeLabel: string; error: string | null; input: unknown; output: unknown }>;
}

async function loadLastFailedExecution(
  workspaceId: string,
  workflowId: string,
  executionId?: string
): Promise<FailedExecutionInfo | null> {
  // Tenant isolation: the workflow must belong to this workspace first.
  await loadWorkflowSummary(workspaceId, workflowId);
  const where = executionId
    ? { id: executionId, workflowId }
    : { workflowId, status: { in: ["FAILED", "COMPLETED"] } };
  const ex = await db.workflowExecution.findFirst({
    where,
    include: { steps: { orderBy: { createdAt: "asc" } } },
    orderBy: { startedAt: "desc" },
  });
  if (!ex) return null;
  return {
    executionId: ex.id,
    status: ex.status,
    error: ex.error,
    failedSteps: ex.steps
      .filter((s) => s.status === "FAILED")
      .map((s) => ({
        nodeId: s.nodeId,
        nodeLabel: s.nodeLabel,
        error: s.error,
        input: safeParse(s.input),
        output: safeParse(s.output),
      })),
  };
}

const ADD_STEP_INSTRUCTIONS: Record<string, string> = {
  add_condition:
    "Add a condition check to the workflow: insert a condition node (e.g. condition.keyword_contains or condition.has_tag) after the trigger or before the first action, and route with flow.if_else when branching is needed. Attach to the most sensible existing node id.",
  add_delay:
    "Add a delay to the workflow: insert a flow.delay node (sensible seconds value) between the trigger/condition and the first send action.",
  add_error_handling:
    "Add error handling: insert a flow.error_branch node at the end of the main path and connect the risky send actions to it, plus an action.notify_team node describing the failure.",
};

/**
 * Run a copilot op. All ops are workspace-scoped; the copilot can never
 * read or modify another workspace's workflows (server-enforced via
 * loadWorkflowSummary). Throws AiNotConfiguredError / CopilotRateLimitedError /
 * AiTimeoutError for the route to map to honest HTTP statuses.
 */
export async function runCopilotOp(req: CopilotRequest): Promise<CopilotResult> {
  const locale = req.locale === "ar" ? "ar" : "en";

  if (isCopilotBlocked(req.workspaceId)) throw new CopilotRateLimitedError();
  recordCopilotRequest(req.workspaceId);

  try {
    switch (req.op) {
      case "generate": {
        const prompt = req.prompt.trim();
        if (!prompt) throw new Error("Empty prompt");
        const skipQuestions = req.answers !== undefined;
        if (!skipQuestions) {
          const qs = clarificationQuestions(prompt, locale);
          if (qs) return { kind: "questions", questions: qs };
        }
        const out = await generateStructuredJson(
          generationSystemPrompt(),
          generationUserMessage(prompt, req.answers ?? {})
        );
        const v = parseModelSpec(out.raw);
        if (!v.ok || !v.spec) {
          throw new Error(`Generation produced an invalid workflow: ${v.errors.join("; ")}`);
        }
        return { kind: "spec", spec: v.spec, repaired: v.repaired, mocked: false };
      }

      case "explain": {
        if (!req.workflowId) throw new Error("workflowId is required for explain");
        const summary = await loadWorkflowSummary(req.workspaceId, req.workflowId);
        const out = await generateText(
          explainSystemPrompt(locale === "ar"),
          workflowSummaryText(summary)
        );
        return { kind: "text", text: out.raw.trim(), mocked: false };
      }

      case "diagnose": {
        if (!req.workflowId) throw new Error("workflowId is required for diagnose");
        const summary = await loadWorkflowSummary(req.workspaceId, req.workflowId);
        const failed = await loadLastFailedExecution(req.workspaceId, req.workflowId, req.executionId);
        if (!failed) {
          return {
            kind: "text",
            text:
              locale === "ar"
                ? "لا توجد تشغيلات فاشلة مسجلة لهذا السير — لا شيء لتشخيصه بعد."
                : "No failed executions recorded for this workflow — nothing to diagnose yet.",
            mocked: false,
          };
        }
        const out = await generateText(
          diagnoseSystemPrompt(locale === "ar"),
          [
            workflowSummaryText(summary),
            `Last failed execution ${failed.executionId} [${failed.status}] error: ${failed.error ?? "n/a"}`,
            ...failed.failedSteps.map(
              (s) => `Failed step: ${s.nodeLabel} (${s.nodeId}) — ${s.error ?? "no error message"}`
            ),
          ].join("\n")
        );
        return { kind: "text", text: out.raw.trim(), mocked: false };
      }

      case "add_condition":
      case "add_delay":
      case "add_error_handling": {
        if (!req.workflowId) throw new Error("workflowId is required for add-step ops");
        const summary = await loadWorkflowSummary(req.workspaceId, req.workflowId);
        const out = await generateStructuredJson(
          addStepSystemPrompt(),
          [
            `Existing workflow:\n${workflowSummaryText(summary)}`,
            `Task: ${ADD_STEP_INSTRUCTIONS[req.op]}`,
            req.prompt.trim() ? `User note: ${req.prompt.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        );
        const v = parseModelFragment(out.raw, new Set(summary.nodes.map((n) => n.id)));
        if (!v.ok || !v.spec) {
          throw new Error(`Add-step produced an invalid fragment: ${v.errors.join("; ")}`);
        }
        return { kind: "spec", spec: v.spec, repaired: v.repaired, mocked: false };
      }

      case "translate": {
        if (!req.workflowId) throw new Error("workflowId is required for translate");
        const summary = await loadWorkflowSummary(req.workspaceId, req.workflowId);
        const toAr = locale === "ar";
        const out = await generateStructuredJson(
          translateSystemPrompt(toAr),
          [
            `Translate these node labels/descriptions (${toAr ? "to Arabic" : "to English"}):`,
            JSON.stringify(
              summary.nodes.map((n) => ({ id: n.id, label: n.label })),
              null,
              2
            ),
          ].join("\n")
        );
        let labels: Record<string, string> = {};
        try {
          const parsed = JSON.parse(out.raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
          labels = (parsed.labels ?? {}) as Record<string, string>;
        } catch {
          throw new Error("Translation produced invalid JSON");
        }
        // Return as a fragment spec with zero nodes — the route maps labels
        // onto existing nodes client-side. We encode via spec.edges=[]
        // and stash labels in `repaired` would be wrong; instead return text.
        // Simpler contract: return the mapping as text JSON for the UI.
        return { kind: "text", text: JSON.stringify({ labels }), mocked: false };
      }

      default:
        throw new Error(`Unknown copilot op: ${req.op}`);
    }
  } catch (e) {
    if (
      e instanceof AiNotConfiguredError ||
      e instanceof AiTimeoutError ||
      e instanceof CopilotRateLimitedError
    ) {
      throw e;
    }
    throw e;
  }
}
