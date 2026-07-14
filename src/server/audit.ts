import { db } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export type AuditInput = {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome: "SUCCESS" | "FAILURE";
  requestId: string;
  metadata?: Record<string, unknown>;
};

export async function writeAudit(input: AuditInput) {
  await db.insert(auditLogs).values({
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    outcome: input.outcome,
    requestId: input.requestId,
    metadata: input.metadata ?? {}
  });
}
