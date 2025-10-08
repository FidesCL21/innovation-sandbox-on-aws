import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";
import { z } from "zod";

import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { isMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  LeaseCollaboratorLambdaEnvironment,
  LeaseCollaboratorLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-collaborator-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const serviceName = "LeaseCollaboratorAssignment";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

const emailSchema = z.string().email();

export function extractCollaboratorEmails(comment?: string | null): string[] {
  if (!comment) {
    return [];
  }

  const normalizedComment = comment.replace(/\r\n/g, "\n");
  const matches: string[] = [];

  for (const line of normalizedComment.split("\n")) {
    const match = /collaborators?\s*:\s*(.+)/i.exec(line);
    if (match?.[1]) {
      matches.push(match[1]);
    }
  }

  if (matches.length === 0) {
    return [];
  }

  const uniqueEmails = new Set<string>();
  const tokens = matches
    .join(",")
    .split(/[;,\s]+/)
    .map((token) => token.trim().replace(/^['"<]+|['">]+$/g, ""))
    .filter(Boolean);

  for (const token of tokens) {
    const parsed = emailSchema.safeParse(token.toLowerCase());
    if (parsed.success) {
      uniqueEmails.add(parsed.data);
    }
  }

  return [...uniqueEmails];
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseCollaboratorLambdaEnvironmentSchema,
  moduleName: "lease-collaborator-assignment",
}).handler(handleLeaseEvent);

export async function handleLeaseEvent(
  event: EventBridgeEvent<string, unknown>,
  context: Context &
    ValidatedEnvironment<LeaseCollaboratorLambdaEnvironment>,
): Promise<string> {
  const detailType = event["detail-type"];

  if (detailType !== "LeaseApproved") {
    logger.info("Ignoring unsupported detail type", { detailType });
    return `Ignored detail-type ${detailType}`;
  }

  const leaseApprovedEvent = LeaseApprovedEvent.parse(event.detail);
  const { leaseId, userEmail } = leaseApprovedEvent.Detail;

  const leaseStore = IsbServices.leaseStore(context.env);
  const leaseResult = await leaseStore.get({
    userEmail,
    uuid: leaseId,
  });

  if (!leaseResult.result) {
    logger.warn("Lease not found for collaborator processing", {
      leaseId,
      userEmail,
    });
    return "Lease not found";
  }

  const lease = leaseResult.result;

  if (!isMonitoredLease(lease)) {
    logger.warn("Lease is not active yet; skipping collaborator assignment", {
      leaseId,
      status: lease.status,
    });
    return "Lease not active";
  }

  if (!lease.awsAccountId) {
    logger.warn("Lease missing AWS account identifier", {
      leaseId,
    });
    return "Lease missing accountId";
  }

  const collaboratorEmails = extractCollaboratorEmails(lease.comments);

  if (collaboratorEmails.length === 0) {
    logger.info("No collaborators found in lease comments", {
      leaseId,
    });
    return "No collaborators requested";
  }

  const idcCredentials = fromTemporaryIsbIdcCredentials(context.env);
  const idcService = IsbServices.idcService(context.env, idcCredentials);

  const assigned: string[] = [];
  const missing: string[] = [];

  for (const email of collaboratorEmails) {
    try {
      const user = await idcService.getUserFromEmail(email);
      if (!user) {
        logger.warn("Collaborator email not found in IDC", {
          email,
          leaseId,
        });
        missing.push(email);
        continue;
      }

      await idcService
        .transactionalGrantUserAccess(lease.awsAccountId, user)
        .complete();

      assigned.push(email);
      logger.info("Assigned collaborator to lease", {
        email,
        leaseId,
        accountId: lease.awsAccountId,
      });
    } catch (error) {
      logger.error("Failed to assign collaborator", {
        error,
        email,
        leaseId,
      });
      throw error;
    }
  }

  if (missing.length > 0) {
    logger.warn("Some collaborator emails were not found in IDC", {
      missing,
      leaseId,
    });
  }

  return `Assigned ${assigned.length} collaborator(s)`;
}
