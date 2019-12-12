'use strict';
const fs = require('fs');

const pluginName = 'serverless-parameter-store-subscriber';
const roleName = 'ParameterStoreSubscriberLambdaRole';
const policyName = 'ParameterStoreSubscriberLambdaRolePolicy';
const subscriberLambdaName = 'ParameterStoreSubscriber';
const cloudWatchEventRuleName = 'ParameterStoreSubscriberEventRule';
const lambdaStatementId = 'ParameterStoreSubscriberStatementId';

const policyDocument = JSON.stringify({
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
      Resource: [
        'arn:aws:logs:ap-southeast-2:731244687126:log-group:/aws/lambda/*:*',
      ],
      Effect: 'Allow',
    },
    {
      Action: ['logs:PutLogEvents'],
      Resource: [
        'arn:aws:logs:ap-southeast-2:731244687126:log-group:/aws/lambda/*:*:*',
      ],
      Effect: 'Allow',
    },
  ],
});

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

const lambdaCode = fs.readFileSync(`${__dirname}/paramStoreSubscriber.js.zip`);

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
 */
module.exports = class ServerlessParameterStoreSubscriber {
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

  async getParam(key) {
    try {
      const param = await this.ssm.getParameter({ Name: key }).promise();
      return param.Parameter.Value;
    } catch (err) {
      return '';
    }
  }

  /**
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
                funcConfig.Environment.Variables[envName] = await this.getParam(
                  paramName
                );
              }
            )
          );
        }
      })
    );
  }

  async createLambdaRole() {
    console.info('Creating new role.');
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

  async lambdaRole() {
    return this.iam
      .getRole({ RoleName: roleName })
      .promise()
      .catch(() => this.createLambdaRole());
  }

  info(message) {
    if (this.options.verbose) {
      this.serverless.cli.log(message);
    }
  }
  async createFunction() {
    this.info(`Creating the Lambda required by ${pluginName}`);
    const role = await this.lambdaRole();
    return this.lambda
      .createFunction({
        Code: {
          ZipFile: lambdaCode,
        },
        Description: 'Serverless Parameter Store Lambda Subscriber',
        FunctionName: subscriberLambdaName,
        Handler: 'paramStoreSubscriber.handler',
        MemorySize: 128,
        Publish: true,
        Role: role.Role.Arn,
        Runtime: 'nodejs10.x',
        Timeout: 15,
      })
      .promise();
  }

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

  async updateLambdaPolicy() {
    this.info(`Updating the Lambda policy required by ${pluginName}`);
    await this.iam
      .putRolePolicy({
        PolicyName: policyName,
        RoleName: roleName,
        PolicyDocument: policyDocument,
      })
      .promise();
  }

  async subscriberLambda() {
    return this.lambda
      .getFunction({
        FunctionName: subscriberLambdaName,
      })
      .promise();
  }

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

  async deployParamStoreSubscriber() {
    await this.updateLambdaPolicy();
    const func = await this.subscriberLambda()
      .then(() => this.updateFunctionCode())
      .catch(() => this.createFunction());
    await this.ensureLogGroupExists();
    await this.updateEventRule(func.FunctionArn);
  }
};
