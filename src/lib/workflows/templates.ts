/**
 * Workflow template gallery manifest.
 * Each template's nodes/edges are valid per the node registry, so they can
 * be POSTed to /api/workflows directly and opened in the builder.
 */
import instagramCommentToDm from "@/workflows/templates/instagram-comment-to-dm.json";
import facebookCommentResponse from "@/workflows/templates/facebook-comment-response.json";
import faqAutoResponder from "@/workflows/templates/faq-auto-responder.json";
import leadQualification from "@/workflows/templates/lead-qualification.json";
import productInquiryAssistant from "@/workflows/templates/product-inquiry-assistant.json";
import priceAvailabilityInquiry from "@/workflows/templates/price-availability-inquiry.json";
import websiteChatLeadCapture from "@/workflows/templates/website-chat-lead-capture.json";
import supportTriage from "@/workflows/templates/support-triage.json";
import unansweredFollowup from "@/workflows/templates/unanswered-followup.json";
import whatsappSupport from "@/workflows/templates/whatsapp-support.json";
import appointmentRouting from "@/workflows/templates/appointment-routing.json";
import orderStatusAssistant from "@/workflows/templates/order-status-assistant.json";
import humanHandoff from "@/workflows/templates/human-handoff.json";
import teamLeadNotification from "@/workflows/templates/team-lead-notification.json";
import feedbackCollection from "@/workflows/templates/feedback-collection.json";

export interface TemplateNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface TemplateEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger: string;
  requiredIntegrations: string[];
  requiredPermissions: string[];
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  sampleMessages: string[];
  publishChecklist: string[];
  limitations: string[];
}

export const TEMPLATES: WorkflowTemplate[] = [
  instagramCommentToDm as WorkflowTemplate,
  facebookCommentResponse as WorkflowTemplate,
  faqAutoResponder as WorkflowTemplate,
  leadQualification as WorkflowTemplate,
  productInquiryAssistant as WorkflowTemplate,
  priceAvailabilityInquiry as WorkflowTemplate,
  websiteChatLeadCapture as WorkflowTemplate,
  supportTriage as WorkflowTemplate,
  unansweredFollowup as WorkflowTemplate,
  whatsappSupport as WorkflowTemplate,
  appointmentRouting as WorkflowTemplate,
  orderStatusAssistant as WorkflowTemplate,
  humanHandoff as WorkflowTemplate,
  teamLeadNotification as WorkflowTemplate,
  feedbackCollection as WorkflowTemplate,
];

export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Template as a copilot-compatible spec (x/y defaulted when missing).
 * Inserting a template goes through the same spec path as copilot output
 * (specToGraph), so every template becomes a real, editable workflow.
 */
export function templateToSpec(t: WorkflowTemplate): {
  nodes: Array<{
    id: string;
    kind: "trigger" | "condition" | "action" | "flow";
    type: string;
    label: string;
    config: Record<string, unknown>;
    x: number;
    y: number;
  }>;
  edges: Array<{ sourceId: string; targetId: string; label: string }>;
} {
  return {
    nodes: t.nodes.map((n, i) => ({
      id: n.id,
      kind: n.kind as "trigger" | "condition" | "action" | "flow",
      type: n.type,
      label: n.label,
      config: n.config ?? {},
      x: n.position?.x ?? 80 + i * 120,
      y: n.position?.y ?? 120,
    })),
    edges: (t.edges ?? []).map((e) => ({
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? "",
    })),
  };
}
