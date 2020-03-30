'use strict';
const fs = require('fs');

const pluginName = 'serverless-parameter-store-subscriber';
const roleName = 'ParameterStoreSubscriberLambdaRole';
const policyName = 'ParameterStoreSubscriberLambdaRolePolicy';
const subscriberLambdaName = 'ParameterStoreSubscriber';
const cloudWatchEventRuleName = 'ParameterStoreSubscriberEventRule';
const lambdaStatementId = 'ParameterStoreSubscriberStatementId';

/**
 * The Lambda we create will need access to all the parameters in the parameter
 * store. If this is a security issue for you then this plugin probably isn't
 * for you at this stage.
 */
const policyDocument = region =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'ssm:GetParameter',
          'ssm:GetParametersByPath',
          'lambda:GetFunctionConfiguration',
          'lambda:UpdateFunctionConfiguration',
        ],
        Resource: '*',
      },
      {
        Action: ['logs:CreateLogStream'],
        Resource: [`arn:aws:logs:${region}:*:log-group:/aws/lambda/*:*`],
        Effect: 'Allow',
      },
      {
        Action: ['logs:PutLogEvents'],
        Resource: [`arn:aws:logs:${region}:*:log-group:/aws/lambda/*:*:*`],
        Effect: 'Allow',
      },
    ],
  });

/**
 * Standard assume-role policy document for an event handler.
 */
const assumeRolePolicyDocument = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: {
        Service: 'lambda.amazonaws.com',
      },
      Action: 'sts:AssumeRole',
    },
  ],
});

/**
 * The lambda code is stored with the plugin to be pushed when it is first
 * loaded. It is compiled typescript but still short enough and readable enough
 * to be easily audited.
 */
const lambdaCode = fs.readFileSync(`${__dirname}/../lambda/subscriber.zip`);

/**
 * Converts a string to PascalCase.
 *
 * e.g.
 * - word => Word
 * - camelCase => CamelCase
 * - kebab-case => KebabCase
 * - snake_case => SnakeCase
 *
 * @param {string} str string to convert
 * @returns passed string in PascalCase
 */
const pascalCase = str =>
  str
    .split(/[-_ ]/)
    .map(word => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join('');

/**
 * The Serverless Parameter Subscriber plugin allows you to specify parameters
 * in your lambda functions. See the README for more info about how to use this.
 */
module.exports = class ServerlessParameterSubscriber {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.options.verbose = this.options.verbose || this.options.v;
    this.provider = serverless ? serverless.getProvider('aws') : null;
    this.custom = serverless.service ? serverless.service.custom : null;
    this.serviceName = serverless.service.service;

    if (!this.provider) {
      throw new Error('This plugin must be used with AWS');
    }
    this.lambda = new this.provider.sdk.Lambda();
    this.ssm = new this.provider.sdk.SSM();
    this.iam = new this.provider.sdk.IAM();
    this.cloudWatchEvents = new this.provider.sdk.CloudWatchEvents();
    this.cloudWatchLogs = new this.provider.sdk.CloudWatchLogs();

    this.hooks = {
      'aws:package:finalize:mergeCustomProviderResources': this.addParamSubscribers.bind(
        this
      ),
      'before:deploy:deploy': this.addFunctionEnvVars.bind(this),
      'deploy:deploy': this.deployParamStoreSubscriber.bind(this),
    };
  }

  /**
   * Log a message to the CLI if verbose is set to true (i.e. the flag -v or
   * --verbose is passed to serverless).
   *
   * @param {string} message message to log
   */
  info(message) {
    if (this.options.verbose) {
      this.serverless.cli.log(message);
    }
  }

  /**
   * Get the value of a paramter from the parameter store by the key.
   *
   * @param {string} key the key of the parameter in the parameter store
   * @returns {string} the value of the parameter or '' if not found or not permitted
   */
  async paramValue(key) {
    try {
      const param = await this.ssm.getParameter({ Name: key }).promise();
      return param.Parameter.Value;
    } catch (err) {
      return '';
    }
  }

  /**
   * Add parameter subscribers for each function that includes parameters. This
   * function will mutate the template. See +addParamSubscriber+ for more info.
   */
  addParamSubscribers() {
    const functions = this.serverless.service.functions;
    const template = this.serverless.service.provider
      .compiledCloudFormationTemplate;

    Object.entries(functions).forEach(([funcKey, func]) => {
      if (func.parameters) {
        Object.entries(func.parameters).forEach(([envName, paramName]) => {
          this.addParamSubscriber(
            template,
            paramName,
            envName,
            funcKey,
            func.name
          );
        });
      }
    });
  }

  /**
   * Adds "subscription" parameters to the parameter store so that we can
   * keep a record of which Lambdas subscribe to which parameters.
   *
   * @param {object} template CloudFormation template to mutate
   * @param {string} paramName name of parameter to subscribe to
   * @param {string} envName name of environment variable to set in the lambda
   * @param {string} funcKey key of function in the serverless config
   * @param {string} funcName full name of lambda in AWS
   */
  addParamSubscriber(template, paramName, envName, funcKey, funcName) {
    const resourceName = `${paramName}Subscriber${pascalCase(
      funcName
    )}${pascalCase(envName)}`;
    template.Resources[resourceName] = {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Description: 'Dynamic parameter',
        Name: `/subscriber/${paramName}/${envName}/${funcKey}`,
        Type: 'String',
        Value: `{"lambda":"${funcName}","environment":"${envName}"}`,
      },
    };
  }

  /**
   * Add environment variables to the CloudFormation template during deployment
   * so that the function will be configured with the latest version of the
   * parameters it is subscribed to.
   *
   * @returns {Promise<void>} resolves when function env vars have been added
   */
  async addFunctionEnvVars() {
    const functions = this.serverless.service.functions;
    const template = this.serverless.service.provider
      .compiledCloudFormationTemplate;

    await Promise.all(
      Object.entries(functions).map(async ([funcKey, func]) => {
        if (func.parameters) {
          await Promise.all(
            Object.entries(func.parameters).map(
              async ([envName, paramName]) => {
                const funcName = `${pascalCase(funcKey)}LambdaFunction`;
                const funcConfig = template.Resources[funcName].Properties;
                if (funcConfig.Environment === undefined) {
                  funcConfig.Environment = { Variables: {} };
                }
                funcConfig.Environment.Variables[
                  envName
                ] = await this.paramValue(paramName);
              }
            )
          );
        }
      })
    );
  }

  /**
   * Create the role required by the CloudWatch parameter update event
   * subscriber (lambda) so that it will have access to the parameter store and
   * the lambdas that subscribe to it.
   *
   * @returns {Promise<object>} the lambda role
   */
  async createLambdaRole() {
    this.info('Creating new role.');
    const role = await this.iam
      .createRole({
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        RoleName: roleName,
        Description:
          'Role used by the Serverless Parameter Store Subscriber Lambda',
      })
      .promise();
    return role;
  }

  /**
   * Return the Lambda Role used by the CloudWatch parameter update event
   * subscriber.
   *
   * @returns {Promise<object>} the lambda role
   */
  async lambdaRole() {
    return this.iam
      .getRole({ RoleName: roleName })
      .promise()
      .catch(() => this.createLambdaRole());
  }

  /**
   * Create the Lambda that subscribes to the CloudWatch parameter update
   * events.
   *
   * @returns {Promise<object>} the Lambda config
   */
  async createFunction(role) {
    this.info(`Creating the Lambda required by ${pluginName}`);
    return this.lambda
      .createFunction({
        Code: {
          ZipFile: lambdaCode,
        },
        Description: 'Serverless Parameter Store Lambda Subscriber',
        FunctionName: subscriberLambdaName,
        Handler: 'lib/handler.handler',
        MemorySize: 128,
        Publish: true,
        Role: role.Role.Arn,
        Runtime: 'nodejs10.x',
        Timeout: 15,
      })
      .promise();
  }

  /**
   * Update the code of the Lambda that subscribes to the CloudWatch parameter
   * update events.
   *
   * @returns {Promise<object>} the Lambda config
   */
  async updateFunctionCode() {
    this.info(`Updating the Lambda required by ${pluginName}`);
    return this.lambda
      .updateFunctionCode({
        FunctionName: subscriberLambdaName,
        Publish: true,
        ZipFile: lambdaCode,
      })
      .promise()
      .catch(err => {
        this.serverless.cli.error(err);
      });
  }

  /**
   * Update the policy used by the CloudWatch parameter update event subscriber.
   *
   * @returns {Promise<void>} resolves when the policy has been updated
   */
  async updateLambdaPolicy() {
    this.info(`Updating the Lambda policy required by ${pluginName}`);
    await this.iam
      .putRolePolicy({
        PolicyName: policyName,
        RoleName: roleName,
        PolicyDocument: policyDocument(this.options.region),
      })
      .promise();
  }

  /**
   * Get the Lambda that subscribes to the CloudWatch parameter update events or
   * reject the request.
   *
   * @returns {Promise<object>} the Lambda config
   */
  async subscriberLambda() {
    return this.lambda
      .getFunction({
        FunctionName: subscriberLambdaName,
      })
      .promise();
  }

  /**
   * Subscribe the given function to the CloudWatch events for updates to the
   * parameters store.
   *
   * @param {string} funcArn the ARN of the subscriber function
   * @returns {Promise<void>} resolves when the function has been subscribed
   */
  async updateEventRule(funcArn) {
    this.info(`Updating the CloudWatch Events rules required by ${pluginName}`);
    const rule = await this.cloudWatchEvents
      .putRule({
        Name: cloudWatchEventRuleName,
        Description:
          'Rule to allow parameter store subscriber to see parameter updates',
        EventPattern: JSON.stringify({
          source: ['aws.ssm'],
          'detail-type': ['Parameter Store Change'],
        }),
        State: 'ENABLED',
      })
      .promise();
    await this.cloudWatchEvents
      .putTargets({
        Rule: cloudWatchEventRuleName,
        Targets: [
          {
            Id: 'parameter-subscriber',
            Arn: funcArn,
          },
        ],
      })
      .promise();
    await this.lambda
      .addPermission({
        Action: 'lambda:InvokeFunction',
        FunctionName: funcArn,
        Principal: 'events.amazonaws.com',
        SourceArn: rule.RuleArn,
        StatementId: lambdaStatementId,
      })
      .promise()
      .catch(err => {
        this.info('Lambda permission already exists - skipping.');
        if (err.code !== 'ResourceConflictException') {
          throw err;
        }
      });
  }

  /**
   * Make sure the log group exists for the subscriber function.
   *
   * @returns {Promise<void>} resolves when the log group has been created
   */
  async ensureLogGroupExists() {
    return this.cloudWatchLogs
      .createLogGroup({
        logGroupName: `/aws/lambda/${subscriberLambdaName}`,
      })
      .promise()
      .catch(err => {
        this.info(`Log group for ${pluginName} already exists`);
      });
  }

  /**
   * Deploy the CloudWatch Events parameter store update subscriber.
   *
   * @returns {Promise<void>} resolves when the subscriber has been deployed
   */
  async deployParamStoreSubscriber() {
    const role = await this.lambdaRole();
    await this.updateLambdaPolicy();
    const func = await this.subscriberLambda()
      .then(() => this.updateFunctionCode())
      .catch(() => this.createFunction(role));
    await this.ensureLogGroupExists();
    await this.updateEventRule(func.FunctionArn);
  }
};
