import { Lambda, SSM } from 'aws-sdk';

interface CloudWatchRuleEvent {
  detail: {
    name: string;
    operation: String;
  };
}

const ssm = new SSM();
const lambda = new Lambda();

interface ParameterSubscription {
  func: string;
  env: string;
}

type ParameterSubscriptions = { [name: string]: ParameterSubscription[] };

const subscriptions = <ParameterSubscriptions>(
  JSON.parse(process.env.PARAMETER_SUBSCRIPTIONS || '{}')
);

/**
 * Updates the Lambda Functions environment variables value to the updated
 * parameter value. The environment variable to update is specified in the
 * subscriber parameter value.
 *
 * @param func the name of the function
 * @param envVar the name environment variable to update
 * @param value the value to set the environment variable to
 */
const updateLambdaFunctions = async (
  func: string,
  envVar: string,
  value: string
): Promise<string> => {
  console.log(
    `Updating Lambda Function [${func}] environment variable [${envVar}] to [${value}].`
  );

  const lambdaFunctionConfig = await lambda
    .getFunctionConfiguration({
      FunctionName: func,
    })
    .promise();

  await lambda
    .updateFunctionConfiguration({
      FunctionName: func,
      Environment: {
        Variables: {
          ...(lambdaFunctionConfig.Environment &&
            lambdaFunctionConfig.Environment.Variables),
          [envVar]: value,
        },
      },
    })
    .promise();

  return `Lambda Function [${func}] has been updated.`;
};

/**
 * Receives event from CloudWatch for SSM parameter change event, e.g. update,
 * create. Processes the change event so that the dependent Lambda Function
 * will get the updated/new SSM parameter value. The Lambda Function that is
 * depending on the SSM parameter value will have an environment variable
 * referencing the SSM parameter value. For example setup:
 *
 * Function Name: myFunction
 * Function ENV: MY_ENV
 * SSM Parameter Key: myParam
 *
 * For the above example setup, the MY_ENV value will be the value of myParam,
 * and this Lambda will update the MY_ENV environment variable based on the
 * change event from myParam.
 *
 * @param event the CloudWatch Parameter update event
 * @returns promise resolving when all environment variables have updated
 */
module.exports.handler = async (event: CloudWatchRuleEvent) => {
  const updatedParamName = event.detail.name;
  const operation = event.detail.operation;
  const subscription = subscriptions[updatedParamName];
  if (
    (operation === 'Update' || operation === 'Create') &&
    subscription !== undefined
  ) {
    const updatedParamValueResult = await ssm
      .getParameter({
        Name: updatedParamName,
      })
      .promise();

    const updatedParamValue = updatedParamValueResult.Parameter?.Value ?? '';

    const updateResults = await subscription.reduce<Promise<string[]>>(
      async (promise, { func, env }) => {
        const results = await promise;
        const newResult = await updateLambdaFunctions(
          func,
          env,
          updatedParamValue
        );
        return [...results, newResult];
      },
      Promise.resolve([])
    );

    console.log(updateResults.join('\n'));
  }

  return { message: 'success' };
};
