// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  EventBus,
  EventField,
  Rule,
  RuleTargetInput,
} from "aws-cdk-lib/aws-events";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import { AccountDriftMonitoringLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/account-drift-monitoring-lambda";
import { AccountLifecycleManagementLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/account-lifecycle-management-lambda";
import { LeaseMonitoringLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/lease-monitoring-lambda";
import { LeaseCollaboratorAssignmentLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/lease-collaborator-assignment-lambda";
import { EmailNotificationLambda } from "@amzn/innovation-sandbox-infrastructure/components/notification/email-notification";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

export type IsbEventBackplaneProps = {
  namespace: string;
  kmsKey: Key;
  readonly orgMgtAccountId: string;
  readonly idcAccountId: string;
};

/**
 * ISB resources responsible for continual core account/lease management operations that occur
 * independently of direct user action.
 */
export class IsbInternalCore {
  readonly eventBus: EventBus;
  readonly leaseMonitoringLambda;
  readonly accountLifecycleManagementLambda;
  readonly accountDriftMonitoringLambda;
  readonly leaseCollaboratorAssignmentLambda;

  constructor(scope: Construct, props: IsbEventBackplaneProps) {
    this.eventBus = new EventBus(scope, "ISBEventBus", {
      description: "core event bus for all ISB activity",
      kmsKey: props.kmsKey,
      deadLetterQueue: new Queue(scope, "ISBEventBusDLQ", {
        queueName: `ISB-${props.namespace}-ISBEventBus-DLQ`,
        encryption: QueueEncryption.KMS,
        encryptionMasterKey: props.kmsKey,
      }),
    });

    IsbComputeResources.globalLogGroup.addToResourcePolicy(
      new PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        effect: Effect.ALLOW,
        principals: [
          new ServicePrincipal("events.amazonaws.com"),
          new ServicePrincipal("delivery.logs.amazonaws.com"),
        ],
        resources: [IsbComputeResources.globalLogGroup.logGroupArn],
      }),
    );

    const dlq = new Queue(scope, "DLQ", {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
    });

    new Rule(scope, "ISBEventBusLogging", {
      description: "logs all events that get sent to the ISB event bus",
      eventBus: this.eventBus,
      targets: [
        {
          bind: () => ({
            arn: IsbComputeResources.globalLogGroup.logGroupArn,
            input: RuleTargetInput.fromObject({
              message: `ISBEventBus received ${EventField.fromPath("$.detail-type")} event`,
              timestamp: EventField.fromPath("$.time"),
            }),
            targetResource: IsbComputeResources.globalLogGroup,
            deadLetterConfig: { arn: dlq.queueArn },
            retryPolicy: {
              maximumRetryAttempts: 20,
            },
          }),
        },
      ],
      eventPattern: {
        source: [{ prefix: "" }] as any[],
      },
    });

    this.leaseMonitoringLambda = new LeaseMonitoringLambda(
      scope,
      "LeaseMonitoring",
      {
        isbEventBus: this.eventBus,
        namespace: props.namespace,
        orgMgtAccountId: props.orgMgtAccountId,
      },
    );

    this.accountLifecycleManagementLambda =
      new AccountLifecycleManagementLambda(
        scope,
        "SandboxAccountLifecycleManagement",
        {
          isbEventBus: this.eventBus,
          namespace: props.namespace,
          orgManagementAccountId: props.orgMgtAccountId,
          idcAccountId: props.idcAccountId,
        },
      );

    this.accountDriftMonitoringLambda = new AccountDriftMonitoringLambda(
      scope,
      "AccountDriftMonitoring",
      {
        isbEventBus: this.eventBus,
        namespace: props.namespace,
        orgMgtAccountId: props.orgMgtAccountId,
      },
    );

    this.leaseCollaboratorAssignmentLambda =
      new LeaseCollaboratorAssignmentLambda(scope, "LeaseCollaboratorAssignment", {
        namespace: props.namespace,
        idcAccountId: props.idcAccountId,
        eventBus: this.eventBus,
      });

    new EmailNotificationLambda(scope, "EmailNotification", {
      isbEventBus: this.eventBus,
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
    });
  }
}
