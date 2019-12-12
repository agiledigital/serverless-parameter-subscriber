import { Lambda, SSM } from 'aws-sdk';
import { ParameterList } from 'aws-sdk/clients/ssm';

interface CloudWatchRuleEvent {
  detail: {
    name: string;
    operation: String;
  };
}

interface SubscriberParamValue {
  lambda: string;
  environment: string;
}

const ssm = new SSM();
const lambda = new Lambda();

/**
 * Subscriber parameter's path of the updated parameter.
 * @param paramName name of the updated parameter.
 */
const subscriberParameterPath = (paramName: string) =>
  `/subscriber/${paramName}/`;

/**
 * Run a function synchronously over a list of objects. The result of all
 * functions is accumulated in an array and returned.
 *
 * @param func function to be called for each item
 * @param items to be fed into function and specified rate
 * @returns promise resolving to an array or results
 */
const synchronously = <T, U>(func: (arg: T) => Promise<U> | U) => (
  items: ReadonlyArray<T>
) =>
  items.reduce(async (accPromise: Promise<readonly U[]>, arg: T): Promise<
    readonly U[]
  > => {
    const acc = await accPromise;
    const result = await func(arg);

    return [...acc, result];
  }, Promise.resolve([]));

/**
 * Updates the Lambda Functions environment variables value to the updated
 * parameter value. The environment variable to update is specified in the
 * subscriber parameter value.
 *
 * @param updatedParamValue the value of the updated parameter.
 */
const updateLambdaFunctions = (updatedParamValue: string) => async (
  parameter: SSM.Parameter
): Promise<string> => {
  console.log(
    `Processing [${parameter.Name}] with value [${parameter.Value}].`
  );

  if (parameter.Value === undefined) {
    return 'Not updating as no subscriber parameter value found.';
  }

  const subscriberParamValue: SubscriberParamValue = JSON.parse(
    parameter.Value
  );

  console.log(
    `Updating Lambda Function [${subscriberParamValue.lambda}] environment variable [${subscriberParamValue.environment}].`
  );

  const lambdaFunctionConfig = await lambda
    .getFunctionConfiguration({
      FunctionName: subscriberParamValue.lambda,
    })
    .promise();

  await lambda
    .updateFunctionConfiguration({
      FunctionName: subscriberParamValue.lambda,
      Environment: {
        Variables: {
          ...lambdaFunctionConfig.Environment?.Variables,
          [subscriberParamValue.environment]: updatedParamValue,
        },
      },
    })
    .promise();

  return `Lambda Function [${subscriberParamValue.lambda}] has been updated.`;
};

/**
 * Fetches the SSM parameters by its path.
 * @param subscriberParamPath subscriber parameter's path of the updated parameter.
 * @param nextToken for fetching next batch of parameters.
 */
const fetchParametersByPath = async (
  subscriberParamPath: string,
  nextToken?: string
): Promise<ParameterList> => {
  const parameterResult = await ssm
    .getParametersByPath({
      Path: subscriberParamPath,
      NextToken: nextToken,
      Recursive: true,
    })
    .promise();

  const parameters = parameterResult.Parameters ?? [];

  if (parameterResult.NextToken === undefined) {
    return parameters;
  } else {
    const nextBatchParams = await fetchParametersByPath(
      subscriberParamPath,
      parameterResult.NextToken
    );
    return [...parameters, ...nextBatchParams];
  }
};

/**
 * Receives event from CloudWatch for SSM parameter change event, e.g. update,
 * create. Processes the change event so that the dependent Lambda Function
 * will get the updated/new SSM parameter value. The Lambda Function that is
 * depending on the SSM parameter value will have environment variables
 * references the SSM parameter value. For example setup:
 *
 * Function Name: myFunction
 * Function ENV: MY_ENV
 * SSM Parameter Key: myParam
 * Subscriber Parameter Key: /subscriber/myParam/MY_ENV/myFunction
 *
 * For the above example setup, the MY_ENV value will be the value of myParam,
 * and this Lambda will update the MY_ENV environment variable based on the
 * change event from myParam. Search of what function to update is done based
 * on the subscriber parameter key path: /subscriber/myParam.
 */
module.exports.handler = async (event: CloudWatchRuleEvent) => {
  const updatedParamName = event.detail.name;
  const operation = event.detail.operation;
  const subscriberParamPath = subscriberParameterPath(updatedParamName);

  const updatedParamValueResult = await ssm
    .getParameter({
      Name: updatedParamName,
    })
    .promise();

  const updatedParamValue = updatedParamValueResult.Parameter?.Value ?? '';

  if (operation === 'Update' || operation === 'Create') {
    const parameters = await fetchParametersByPath(subscriberParamPath);

    const updateResults = await synchronously(
      updateLambdaFunctions(updatedParamValue)
    )(parameters);

    console.log(updateResults.join('\n'));
  }

  return { message: 'success' };
};
