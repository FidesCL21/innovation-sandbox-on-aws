import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const LeaseCollaboratorLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ISB_NAMESPACE: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    LEASE_TABLE_NAME: z.string(),
    DEFAULT_PERMISSION_SET_ARN: z.string().optional(),
  });

export type LeaseCollaboratorLambdaEnvironment = z.infer<
  typeof LeaseCollaboratorLambdaEnvironmentSchema
>;
