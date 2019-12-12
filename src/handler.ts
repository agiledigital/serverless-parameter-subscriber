import { SSM, Lambda } from 'aws-sdk';

interface CloudWatchRuleEvent {
  detail: {
    name: string,
    operation: String
  }
}

interface SubscriberParamValue {
  lambda: string,
  environment: string
}

const ssm = new SSM();
const lambda = new Lambda();

/**
 * Subscriber parameter's path of the updated parameter.
 * @param paramName name of the updated parameter.
 */
const subscriberParameterPath = (paramName: string) => `/subscriber/${paramName}/`

/**
 * Updates the Lambda Functions environment variables value to the updated parameter value.
 * The environment variable to update is specified in the subscriber parameter value.
 * @param updatedParamValue the value of the updated parameter.
 */
const updateLambdaFunctions = (updatedParamValue: string) => async (parameter: SSM.Parameter) => {
  console.log(`Processing [${parameter.Name}] with value [${parameter.Value}].`)

  if (parameter.Value === undefined) {
    return Promise.resolve('Not updating as no subscriber parameter value found.');
  }

  const subscriberParamValue: SubscriberParamValue = JSON.parse(parameter.Value);
  
  console.log(`Updating Lambda Function [${subscriberParamValue.lambda}] environment variable [${subscriberParamValue.environment}].`);

  await lambda.updateFunctionConfiguration({
    FunctionName: subscriberParamValue.lambda,
    Environment: {
      Variables: {
        [subscriberParamValue.environment]: updatedParamValue
      }
    }
  }).promise();

  return `Lambda Function [${subscriberParamValue.lambda}] has been updated.`;
}

/**
 * Receives event from CloudWatch for SSM parameter change event, e.g. update, create.
 * Processes the change event so that the dependent Lambda Function will get the updated/new SSM parameter value.
 * The Lambda Function that is depending on the SSM parameter value will have environment variables references
 * the SSM parameter value. For example setup:
 * 
 * Function Name: myFunction
 * Function ENV: MY_ENV
 * SSM Parameter Key: myParam
 * Subscriber Parameter Key: /subscriber/myParam/MY_ENV/myFunction
 * 
 * For the above example setup, the MY_ENV value will be the value of myParam, and this Lambda will update the MY_ENV
 * environment variable based on the change event from myParam. Search of what function to update is done based on the
 * subscriber parameter key path: /subscriber/myParam.
 */
module.exports.parameterSubscriber = async (event: CloudWatchRuleEvent) => {
  try {
    const updatedParamName = event.detail.name;
    const operation = event.detail.operation;
    const subscriberParamPath = subscriberParameterPath(updatedParamName);

    const updatedParamValueResult = await ssm.getParameter({
      Name: updatedParamName
    }).promise();

    const updatedParamValue = updatedParamValueResult.Parameter?.Value || '';

    if (operation === 'Update' || operation === 'Create') {
      const parameterResult = await ssm.getParametersByPath({ 
        Path: subscriberParamPath,
        Recursive: true
      }).promise();

      if (parameterResult.Parameters !== undefined) {
        const updateResults = await Promise.all(parameterResult.Parameters.map(updateLambdaFunctions(updatedParamValue)));

        console.log(updateResults.join('\n'));
      }
    }

    return { message: 'success' }
  }
  catch (e) {
    console.error(e);
    return { message: 'failed' };
  }
};
