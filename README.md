# Serverless Parameter Subscriber

[![CircleCI](https://circleci.com/gh/agiledigital/serverless-parameter-subscriber.svg?style=svg)](https://circleci.com/gh/agiledigital/serverless-parameter-subscriber)
[![npm version](https://badge.fury.io/js/%40agiledigital%2Fserverless-parameter-subscriber.svg)](https://badge.fury.io/js/%40agiledigital%2Fserverless-parameter-subscriber)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

This is a serverless plugin that enables you to subscribe environment variables
in Lambdas to Systems Manager Parameter Store values. This enables you to share
configuration values that are used across multiple Lambdas in the Parameter
store and access them as environment variables. Need to update the parameter
value? Simply update the value once in the Parameter Store and within seconds,
all subscribing Lambdas will be using the updated value without the extra
overhead of calling out the the parameter store for every request.

# Table of Contents

- [Install](#install)
- [Setup](#setup)

## Install

Run `npm install` in your Serverless project.

`$ npm install --save-dev @agiledigital/serverless-parameter-subscriber`

Add the plugin to your serverless.yml file

```yml
plugins:
  - '@agiledigital/serverless-parameter-subscriber'
```

## Setup

The following is an example `serverless.yml` file demonstrating this plugin's
usage. You can try the example included in the repository.

```yml
service: params

provider:
  name: aws
  runtime: nodejs10.x
  region: ap-southeast-2
  stage: ${opt:stage, 'dev'}

functions:
  one:
    handler: handler.one
    # the following `parameters` value is where the magic happens.
    # ENV_VAR_ONE is the name of the environment variable in the function
    # ParamValue will be the name of the parameter in the Parameter Store.
    parameters:
      ENV_VAR_ONE: ParamValue

  two:
    handler: handler.two
    parameters:
      # this parameter will be defined outside of this service.
      ENV_VAR_TWO: ExternalParamValue

resources:
  Resources:
    # We create the parameter that the funtions subscribe to here, but the
    # parameter can be created any way you like including in another service.
    ParamValue:
      Type: AWS::SSM::Parameter
      Properties:
        Description: Dynamic parameter
        Name: ParamValue
        Type: String
        Value: hello, dave

plugins:
  - '@agiledigital/serverless-parameter-subscriber'
```
