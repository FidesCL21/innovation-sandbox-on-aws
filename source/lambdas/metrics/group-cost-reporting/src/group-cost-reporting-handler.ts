// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  ExpiredLease,
  ExpiredLeaseStatus,
  isExpiredLease,
  MonitoredLease,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  GroupCostReportingLambdaEnvironment,
  GroupCostReportingLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/group-cost-reporting-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Context, EventBridgeEvent } from "aws-lambda";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";

type ReportCadence = "monthly" | "daily";

interface CostReportEvent {
  reportMonth?: string;
  reportType?: ReportCadence;
  reportDate?: string; // yyyy-MM-dd for daily overrides
}

interface RelevantLeaseData {
  readonly costReportGroup: string | undefined;
  readonly awsAccountId: string;
  readonly startDate: DateTime;
  readonly endDate: DateTime;
  readonly userEmail: string | undefined;
}

interface ReportContext {
  readonly startDate: DateTime;
  readonly endDate: DateTime;
  readonly cadence: ReportCadence;
  readonly storageYear: string;
  readonly storageMonth: string;
  readonly fileLabel: string;
  readonly reportMonthLabel: string;
  readonly shouldPublishEvents: boolean;
}

const GROUP_COST_REPORT_CONFIG = {
  DEFAULT_CURRENCY: "USD",
  STARTING_DELAY: 1000,
  MAX_ATTEMPTS: 5,
  DEFAULT_GROUP_NAME: "No cost report group",
  DEFAULT_USER_NAME: "Unknown user",
};

const serviceName = "GroupCostReporting";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: GroupCostReportingLambdaEnvironmentSchema,
  moduleName: "group-cost-reporting",
}).handler(generateReport);

export async function generateReport(
  _event: EventBridgeEvent<string, unknown>,
  context: Context & ValidatedEnvironment<GroupCostReportingLambdaEnvironment>,
) {
  const reportContext = getReportPeriod(
    (_event as Record<string, unknown>)?.detail ?? _event,
  );
  logger.debug(
    `Running ${reportContext.cadence} cost report for ${reportContext.fileLabel} on ${DateTime.now().toISO()}`,
  );
  const eventBridgeClient = IsbServices.isbEventBridge(context.env);
  const leaseStore = IsbServices.leaseStore(context.env);
  const costExplorerService = IsbServices.costExplorer(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const s3Client = IsbClients.s3({
    USER_AGENT_EXTRA: context.env.USER_AGENT_EXTRA,
  });
  const { startDate, endDate } = reportContext;

  try {
    const leases = await fetchRelevantLeases(
      leaseStore,
      startDate,
      endDate,
    );

    const uniqueAccountIds = [
      ...new Set(leases.map((lease) => lease.awsAccountId)),
    ];
    const dailyCostsByAccount =
      await costExplorerService.getDailyCostsByAccount(
        uniqueAccountIds,
        startDate,
        endDate,
      );

    const costReportGroupTotals = calculateCostsByGroup(
      leases,
      dailyCostsByAccount,
    );
    const userCostTotals = calculateCostsByUser(leases, dailyCostsByAccount);

    const costGroupCsv = generateCSV(
      costReportGroupTotals,
      "CostReportGroup",
      startDate,
      endDate,
      GROUP_COST_REPORT_CONFIG.DEFAULT_CURRENCY,
    );
    const userCostCsv = generateCSV(
      userCostTotals,
      "UserEmail",
      startDate,
      endDate,
      GROUP_COST_REPORT_CONFIG.DEFAULT_CURRENCY,
    );

    const costGroupFileName = await uploadReportToS3({
      s3Client,
      bucketName: context.env.REPORT_BUCKET_NAME,
      csvBody: costGroupCsv,
      reportContext,
      dimension: "cost-groups",
    });

    await uploadReportToS3({
      s3Client,
      bucketName: context.env.REPORT_BUCKET_NAME,
      csvBody: userCostCsv,
      reportContext,
      dimension: "users",
    });

    if (reportContext.shouldPublishEvents) {
      await eventBridgeClient.sendIsbEvent(
        tracer,
        new GroupCostReportGeneratedEvent({
          reportMonth: reportContext.reportMonthLabel,
          fileName: costGroupFileName,
          bucketName: context.env.REPORT_BUCKET_NAME,
          timestamp: DateTime.now().toISO(),
        }),
      );
    }
  } catch (error) {
    logger.error("Cost report generation failed", {
      reportMonth: reportContext.reportMonthLabel,
      reportPeriod: {
        start: startDate.toISO(),
        end: endDate.toISO(),
      },
      bucketName: context.env.REPORT_BUCKET_NAME,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });

    if (reportContext.shouldPublishEvents) {
      await eventBridgeClient.sendIsbEvent(
        tracer,
        new GroupCostReportGeneratedFailureEvent({
          reportMonth: reportContext.reportMonthLabel,
          timestamp: DateTime.now().toISO(),
          logName: context.logGroupName,
        }),
      );
    }
    throw error;
  }
}

async function fetchRelevantLeases(
  leaseStore: LeaseStore,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
) {
  const statuses: (MonitoredLeaseStatus | ExpiredLeaseStatus)[] = [
    "Active",
    "Frozen",
    "AccountQuarantined",
    "BudgetExceeded",
    "Ejected",
    "Expired",
    "ManuallyTerminated",
  ];

  const leases: (MonitoredLease | ExpiredLease)[] = (
    await Promise.all(
      statuses.map((status) =>
        backOff(
          () =>
            collect(stream(leaseStore, leaseStore.findByStatus, { status })),
          {
            numOfAttempts: GROUP_COST_REPORT_CONFIG.MAX_ATTEMPTS,
            jitter: "full",
            startingDelay: GROUP_COST_REPORT_CONFIG.STARTING_DELAY,
            retry(error) {
              if (
                error.name === "ThrottlingException" ||
                error.name === "ProvisionedThroughputExceededException" ||
                error.name === "ServiceUnavailableException" ||
                error.name === "InternalServerError"
              ) {
                logger.warn("Retrying lease scan due to error", {
                  error: error.message,
                });
                return true;
              }
              return false;
            },
          },
        ),
      ),
    )
  ).flat() as (MonitoredLease | ExpiredLease)[];

  return leases
    .filter((lease) =>
      isLeaseInReportPeriod(lease, startOfLastMonth, endOfLastMonth),
    )
    .map((lease) => ({
      costReportGroup: lease.costReportGroup,
      awsAccountId: lease.awsAccountId,
      startDate: DateTime.fromISO(lease.startDate),
      endDate: isExpiredLease(lease) ? DateTime.fromISO(lease.endDate) : now(),
      userEmail: lease.userEmail,
    }));
}

function isLeaseInReportPeriod(
  lease: MonitoredLease | ExpiredLease,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
) {
  const leaseStart = DateTime.fromISO(lease.startDate);
  const leaseEnd = isExpiredLease(lease)
    ? DateTime.fromISO(lease.endDate)
    : now();
  return leaseStart <= endOfLastMonth && leaseEnd >= startOfLastMonth;
}

function calculateCostsByGroup(
  relevantLeaseData: RelevantLeaseData[],
  dailyCostsByAccount: Record<string, Record<string, number>>,
) {
  return calculateCostsByKey(
    relevantLeaseData,
    dailyCostsByAccount,
    (lease) =>
      lease.costReportGroup ?? GROUP_COST_REPORT_CONFIG.DEFAULT_GROUP_NAME,
  );
}

function calculateCostsByUser(
  relevantLeaseData: RelevantLeaseData[],
  dailyCostsByAccount: Record<string, Record<string, number>>,
) {
  return calculateCostsByKey(
    relevantLeaseData,
    dailyCostsByAccount,
    (lease) => lease.userEmail ?? GROUP_COST_REPORT_CONFIG.DEFAULT_USER_NAME,
  );
}

function calculateCostsByKey(
  relevantLeaseData: RelevantLeaseData[],
  dailyCostsByAccount: Record<string, Record<string, number>>,
  keySelector: (lease: RelevantLeaseData) => string,
) {
  return relevantLeaseData.reduce((totals, lease) => {
    const leaseTotalCost = calculateLeaseCost(lease, dailyCostsByAccount);
    const key = keySelector(lease);
    totals[key] = (totals[key] || 0) + leaseTotalCost;
    return totals;
  }, {} as Record<string, number>);
}

function calculateLeaseCost(
  lease: RelevantLeaseData,
  dailyCostsByAccount: Record<string, Record<string, number>>,
) {
  const accountCosts = dailyCostsByAccount[lease.awsAccountId] ?? {};
  const leaseTotalCost = Object.entries(accountCosts)
    .map(([dateStr, cost]) => ({
      date: DateTime.fromFormat(dateStr, "yyyy-MM-dd"),
      cost,
    }))
    .filter(({ date }) => date >= lease.startDate && date <= lease.endDate)
    .reduce((total, { cost }) => total + cost, 0);

  return leaseTotalCost;
}

interface UploadParams {
  s3Client: S3Client;
  bucketName: string;
  csvBody: string;
  reportContext: ReportContext;
  dimension: "cost-groups" | "users";
}

async function uploadReportToS3({
  s3Client,
  bucketName,
  csvBody,
  reportContext,
  dimension,
}: UploadParams) {
  const basePrefix = `reports/${reportContext.storageYear}/${reportContext.storageMonth}/${dimension}/${reportContext.cadence}`;
  const fileName =
    reportContext.cadence === "daily"
      ? `${basePrefix}/${reportContext.fileLabel}.csv`
      : `${basePrefix}/cost-report-${reportContext.fileLabel}.csv`;

  const s3PutCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: csvBody,
    ContentType: "text/csv",
    ContentDisposition: `attachment; filename="${fileName.split(
      "/",
    ).pop()}"`,
  });

  await s3Client.send(s3PutCommand);
  return fileName;
}

function generateCSV(
  costTotals: Record<string, number>,
  primaryColumnHeader: string,
  startDate: DateTime,
  endDate: DateTime,
  currency: string,
): string {
  const headers = [
    primaryColumnHeader,
    "StartDate",
    "EndDate",
    "Cost",
    "Currency",
  ];

  const rows = Object.entries(costTotals).map(([primaryValue, cost]) => [
    primaryValue,
    startDate.toFormat("yyyy-MM-dd"),
    endDate.toFormat("yyyy-MM-dd"),
    cost.toFixed(2),
    currency,
  ]);
  return [headers, ...rows].map((row) => row.join(",")).join("\n");
}

// determines if we should run a monthly summary (default) or a daily incremental report
function getReportPeriod(eventDetail: unknown): ReportContext {
  const event = eventDetail as CostReportEvent | undefined;
  if (event?.reportType === "daily") {
    return buildDailyReportContext(event);
  }
  return buildMonthlyReportContext(event);
}

function buildDailyReportContext(event: CostReportEvent | undefined): ReportContext {
  let targetDate = now().minus({ days: 1 });
  if (event?.reportDate) {
    const parsed = DateTime.fromISO(event.reportDate);
    if (parsed.isValid) {
      targetDate = parsed;
    }
  }
  const startDate = targetDate.startOf("day");
  const endDate = targetDate.endOf("day");

  return {
    startDate,
    endDate,
    cadence: "daily",
    storageYear: startDate.toFormat("yyyy"),
    storageMonth: startDate.toFormat("MM"),
    fileLabel: startDate.toFormat("yyyy-MM-dd"),
    reportMonthLabel: startDate.toFormat("yyyy-MM"),
    shouldPublishEvents: false,
  };
}

function buildMonthlyReportContext(event: CostReportEvent | undefined): ReportContext {
  let targetDate = now().minus({ months: 1 });
  if (event?.reportMonth) {
    const parsed = DateTime.fromFormat(event.reportMonth, "yyyy-MM");
    if (parsed.isValid) {
      targetDate = parsed;
    }
  }

  const startDate = targetDate.startOf("month");
  const endDate = targetDate.endOf("month");

  return {
    startDate,
    endDate,
    cadence: "monthly",
    storageYear: startDate.toFormat("yyyy"),
    storageMonth: startDate.toFormat("MM"),
    fileLabel: startDate.toFormat("yyyy-MM"),
    reportMonthLabel: startDate.toFormat("yyyy-MM"),
    shouldPublishEvents: true,
  };
}
