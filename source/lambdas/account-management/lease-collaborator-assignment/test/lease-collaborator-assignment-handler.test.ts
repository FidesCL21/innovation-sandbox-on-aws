import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { MonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseApprovedEventSchema } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import {
  LeaseCollaboratorLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-collaborator-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  extractCollaboratorEmails,
  handleLeaseEvent,
} from "@amzn/innovation-sandbox-lease-collaborator-assignment/lease-collaborator-assignment-handler.js";

vi.mock("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js", async () => {
  const actual = await vi.importActual<
    typeof import("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js")
  >("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js");
  return {
    ...actual,
    fromTemporaryIsbIdcCredentials: vi.fn(),
  };
});

describe("extractCollaboratorEmails", () => {
  it("returns empty array when no collaborators are present", () => {
    expect(extractCollaboratorEmails(undefined)).toEqual([]);
    expect(extractCollaboratorEmails("no collaborators listed here")).toEqual(
      [],
    );
  });

  it("extracts and normalizes collaborator emails", () => {
    const result = extractCollaboratorEmails(
      "Please provision access.\nCollaborators: Alice@example.com, bob@example.com ; carol@example.com",
    );

    expect(result).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
  });

  it("removes duplicates and surrounding punctuation", () => {
    const result = extractCollaboratorEmails(
      "collaborators: <user@example.com>, 'user@example.com'",
    );

    expect(result).toEqual(["user@example.com"]);
  });
});

describe("handleLeaseEvent", () => {
  const testEnv = generateSchemaData(
    LeaseCollaboratorLambdaEnvironmentSchema,
  );

  let leaseStoreSpy: MockInstance;
  let idcServiceSpy: MockInstance;

  const collaboratorEmails = [
    "alice@example.com",
    "bob@example.com",
  ];

  const monitoredLease: MonitoredLease = {
    userEmail: "owner@example.com",
    uuid: "lease-1234",
    originalLeaseTemplateUuid: "tmpl-1",
    originalLeaseTemplateName: "Default",
    leaseDurationInHours: 24,
    comments: `Need access\nCollaborators: ${collaboratorEmails.join(", ")}`,
    approvedBy: "approver@example.com",
    status: "Active",
    awsAccountId: "123456789012",
    startDate: new Date().toISOString(),
    expirationDate: new Date(Date.now() + 86400000).toISOString(),
    lastCheckedDate: new Date().toISOString(),
    totalCostAccrued: 0,
    maxSpend: 100,
    budgetThresholds: [],
    durationThresholds: [],
  };

  const leaseApprovedDetail = generateSchemaData(LeaseApprovedEventSchema);
  leaseApprovedDetail.leaseId = monitoredLease.uuid;
  leaseApprovedDetail.userEmail = monitoredLease.userEmail;

  beforeEach(() => {
    bulkStubEnv(testEnv);

    leaseStoreSpy = vi.spyOn(IsbServices, "leaseStore");
    leaseStoreSpy.mockReturnValue({
      get: vi.fn().mockResolvedValue({ result: monitoredLease }),
    } as any);

    idcServiceSpy = vi.spyOn(IsbServices, "idcService");
    idcServiceSpy.mockReturnValue({
      getUserFromEmail: vi
        .fn()
        .mockImplementation((email: string) =>
          collaboratorEmails.includes(email)
            ? {
                displayName: email,
                email,
                userId: `user-${email}`,
                userName: email,
                roles: ["User"],
              }
            : undefined,
        ),
      transactionalGrantUserAccess: vi.fn().mockReturnValue({
        complete: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(fromTemporaryIsbIdcCredentials).mockReturnValue({} as any);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("assigns collaborators listed in comments", async () => {
    const result = await handleLeaseEvent(
      {
        id: "1",
        version: "0",
        account: "123456789012",
        region: "us-east-1",
        time: new Date().toISOString(),
        source: "test",
        resources: [],
        "detail-type": "LeaseApproved",
        detail: leaseApprovedDetail,
      },
      mockContext(testEnv),
    );

    expect(idcServiceSpy).toHaveBeenCalledTimes(1);
    const idcService = idcServiceSpy.mock.results[0]!.value as any;

    expect(idcService.getUserFromEmail).toHaveBeenCalledTimes(2);
    expect(idcService.transactionalGrantUserAccess).toHaveBeenCalledTimes(2);
    expect(result).toEqual("Assigned 2 collaborator(s)");
  });

  it("ignores events without collaborator metadata", async () => {
    const leaseWithoutCollaborators = {
      ...monitoredLease,
      comments: "No collaborators",
    } satisfies MonitoredLease;

    leaseStoreSpy.mockReturnValue({
      get: vi.fn().mockResolvedValue({ result: leaseWithoutCollaborators }),
    } as any);

    const result = await handleLeaseEvent(
      {
        id: "1",
        version: "0",
        account: "123456789012",
        region: "us-east-1",
        time: new Date().toISOString(),
        source: "test",
        resources: [],
        "detail-type": "LeaseApproved",
        detail: leaseApprovedDetail,
      },
      mockContext(testEnv),
    );

    expect(idcServiceSpy).not.toHaveBeenCalled();
    expect(result).toEqual("No collaborators requested");
  });

  it("skips unsupported detail types", async () => {
    const result = await handleLeaseEvent(
      {
        id: "1",
        version: "0",
        account: "123456789012",
        region: "us-east-1",
        time: new Date().toISOString(),
        source: "test",
        resources: [],
        "detail-type": "LeaseTerminated",
        detail: {},
      },
      mockContext(testEnv),
    );

    expect(result).toEqual("Ignored detail-type LeaseTerminated");
  });
});
