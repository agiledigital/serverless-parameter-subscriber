'use strict';
const fs = require('fs');

const iamRoleName = 'IamRoleServerlessParameterSubscriber';
const logGroupName = 'ServerlessParameterSubscriberLogGroup';
const prefix = 'ServerlessParameterSubscriber';
const subscriberLambdaName = `${prefix}Lambda`;
const cloudWatchEventsRuleName = `${prefix}EventRule`;
const lambdaPermissionName = `${prefix}LambdaPermission`;

/**
 * The lambda code is stored with the plugin to be pushed when it is first
 * loaded. It is compiled typescript but still short enough and readable enough
 * to be easily audited.
 */
const lambdaCode = fs
  .readFileSync(`${__dirname}/../lambda/handler.js`)
  .toString();

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
    this.servicePrefix = `${this.serviceName}-${options.stage}`;
    this.paramCache = {};

    if (!this.provider) {
      throw new Error('This plugin must be used with AWS');
    }
    this.ssm = new this.provider.sdk.SSM();

    this.hooks = {
      'aws:package:finalize:mergeCustomProviderResources': this.updateCloudFormation.bind(
        this
      ),
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
    if (this.paramCache[key] === undefined) {
      try {
        const param = await this.ssm.getParameter({ Name: key }).promise();
        this.paramCache[key] = param.Parameter.Value;
      } catch (err) {
        this.info(`Error fetching parameter value [${key}]: ${err}`);
        this.paramCache[key] = '';
      }
    }
    return this.paramCache[key];
  }

  /**
   * Cache all locally set parameters so that the functions that use them will
   * be set immediately.
   *
   * @param {CloudFormationResource} resources from template
   */
  cacheLocalParameters(resources) {
    resources.forEach(resource => {
      if (resource.Type === 'AWS::SSM::Parameter') {
        this.paramCache[resource.Properties.Name] = resource.Properties.Value;
      }
    });
  }

  /**
   * Add environment variables to the CloudFormation template during deployment
   * so that the function will be configured with the latest version of the
   * parameters it is subscribed to.
   *
   * @returns {Promise<void>} resolves when function env vars have been added
   */
  async updateCloudFormation() {
    const functions = this.serverless.service.functions;
    const template = this.serverless.service.provider
      .compiledCloudFormationTemplate;
    const parameterSubscribers = {};
    const funcArns = [];
    const paramArns = new Set();

    this.cacheLocalParameters(Object.values(template.Resources));

    await Promise.all(
      Object.entries(functions).map(async ([funcKey, func]) => {
        if (func.parameters) {
          funcArns.push({
            'Fn::Sub': `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${func.name}`,
          });
          await Promise.all(
            Object.entries(func.parameters).map(
              async ([envName, paramName]) => {
                parameterSubscribers[paramName] = [
                  ...(parameterSubscribers[paramName] || []),
                  {
                    func: func.name,
                    env: envName,
                  },
                ];
                paramArns.add(
                  `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/${paramName}`
                );
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

    template.Resources = {
      ...template.Resources,
      [iamRoleName]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: ['lambda.amazonaws.com'],
                },
                Action: ['sts:AssumeRole'],
              },
            ],
          },
          Policies: [
            {
              PolicyName: `${this.servicePrefix}-ServerlessParameterSubscriberPolicy`,
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['logs:CreateLogStream', 'logs:CreateLogGroup'],
                    Resource: [
                      {
                        'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${this.servicePrefix}*:*`,
                      },
                    ],
                  },
                  {
                    Effect: 'Allow',
                    Action: ['logs:PutLogEvents'],
                    Resource: [
                      {
                        'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${this.servicePrefix}*:*:*`,
                      },
                    ],
                  },
                  {
                    Effect: 'Allow',
                    Action: ['ssm:GetParameter'],
                    Resource: Array.from(paramArns).map(arn => ({
                      'Fn::Sub': arn,
                    })),
                  },
                  {
                    Effect: 'Allow',
                    Action: [
                      'lambda:GetFunctionConfiguration',
                      'lambda:UpdateFunctionConfiguration',
                    ],
                    Resource: funcArns,
                  },
                ],
              },
            },
          ],
          Path: '/',
          RoleName: {
            'Fn::Sub': `${this.servicePrefix}-\${AWS::Region}-${iamRoleName}`,
          },
        },
      },

      [logGroupName]: {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `/aws/lambda/${this.servicePrefix}-${prefix}`,
        },
      },
      [subscriberLambdaName]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Code: {
            ZipFile: lambdaCode,
          },
          FunctionName: `${this.servicePrefix}-${prefix}`,
          Handler: 'index.handler',
          MemorySize: 256,
          Role: {
            'Fn::GetAtt': [iamRoleName, 'Arn'],
          },
          Runtime: 'nodejs12.x',
          Timeout: 6,
          Environment: {
            Variables: {
              PARAMETER_SUBSCRIPTIONS: JSON.stringify(parameterSubscribers),
            },
          },
        },
        DependsOn: [logGroupName, iamRoleName],
      },

      [cloudWatchEventsRuleName]: {
        Type: 'AWS::Events::Rule',
        Properties: {
          EventPattern: {
            source: ['aws.ssm'],
            'detail-type': ['Parameter Store Change'],
          },
          State: 'ENABLED',
          Targets: [
            {
              Arn: {
                'Fn::GetAtt': [subscriberLambdaName, 'Arn'],
              },
              Id: 'updateCloudWatchEvent',
            },
          ],
        },
      },
      [lambdaPermissionName]: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: {
            'Fn::GetAtt': [subscriberLambdaName, 'Arn'],
          },
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: {
            'Fn::GetAtt': [cloudWatchEventsRuleName, 'Arn'],
          },
        },
      },
    };
  }
};
