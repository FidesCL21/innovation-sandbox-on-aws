import { Duration } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { LeaseCollaboratorLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-collaborator-lambda-environment.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import { EventsToLambda } from "@amzn/innovation-sandbox-infrastructure/components/events-to-lambda";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface LeaseCollaboratorAssignmentLambdaProps {
  namespace: string;
  idcAccountId: string;
  eventBus: EventBus;
}

export class LeaseCollaboratorAssignmentLambda extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: LeaseCollaboratorAssignmentLambdaProps,
  ) {
    super(scope, id);

    const lambda = new IsbLambdaFunction(this, id, {
      description:
        "Assigns requested collaborators to leases when approvals are processed",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "lease-collaborator-assignment",
        "src",
        "lease-collaborator-assignment-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      envSchema: LeaseCollaboratorLambdaEnvironmentSchema,
      logGroup: IsbComputeResources.globalLogGroup,
      environment: {
        ISB_NAMESPACE: props.namespace,
        LEASE_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.leaseTable,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(
          scope,
          props.namespace,
          props.idcAccountId,
        ),
      },
      reservedConcurrentExecutions: 1,
      timeout: Duration.minutes(2),
    });

    const lambdaRole = lambda.lambdaFunction.role! as Role;

    IntermediateRole.addTrustedRole(lambdaRole);
    grantIsbDbReadOnly(
      scope,
      lambda,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    grantIsbSsmParameterRead(
      lambdaRole,
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );

    new EventsToLambda(this, "LeaseCollaboratorAssignments", {
      eventBus: props.eventBus,
      lambdaFunction: lambda.lambdaFunction,
      lambdaFunctionProps: {
        maxEventAge: Duration.hours(6),
        retryAttempts: 3,
      },
      ruleProps: {
        eventBus: props.eventBus,
        description: "Assigns collaborators when leases are approved",
        enabled: true,
        eventPattern: {
          detailType: ["LeaseApproved"],
        },
      },
    });
  }
}
