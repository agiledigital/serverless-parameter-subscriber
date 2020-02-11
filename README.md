## serverless-parameter-subscriber

[![CircleCI](https://circleci.com/gh/agiledigital/serverless-parameter-subscriber.svg?style=svg)](https://circleci.com/gh/agiledigital/serverless-parameter-subscriber)
[![npm version](https://badge.fury.io/js/%40agiledigital%2Fserverless-parameter-subscriber.svg)](https://badge.fury.io/js/%40agiledigital%2Fserverless-parameter-subscriber)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

So you have a configuration value that you need to make available in multiple
different Lambdas. You can add it as an environment variable in each Lambda but
then it's a hassle to update them all. You can add it as a parameter to the
SSM parameter store but then you need to get it each time your handler is
called, adding to the latency. You can cache it locally but you need to think
about timeouts so that a perpetually warm Lambda will eventually get updated
when a value changes.

It's complicated!

Now you have _serverless-parameter-subscriber_. Keep your parameters stored in
the parameter store and use them like environment variables from your Lambdas.
Keep reading to learn how.

# Table of Contents

- [Install](#install)
- [Setup](#setup)
- [How Does it Work?](#how-does-it-work)

## Install

Run `npm install` in your Serverless project.

`$ npm install --save-dev @agiledigital/serverless-parameter-subscriber`

Add the plugin to your serverless.yml file

```yml
plugins:
  - '@agiledigital/serverless-parameter-subscriber'
```

## Setup

Add your parameters just like you would your environment variables, except,
instead of the value, you'll pass the SSM parameter store key. Say we have an
endpoint that needs the name of database. We'd configure it like so:

```yml
functions:
  customer:
    handler: customer.getHandler
    parameters:
      DATABASE_NAME: DatabaseName
    events:
      - http:
          path: customers/{id}
          method: get
```

We can now access the value in the handler like so (in JavaScript or
TypeScript):

```JavaScript
export const handler = event => {
  const databaseName = process.env.DATABASE_NAME;
  // ...
}
```

Next time the name of the database changes, just update it in the parameter
store and it'll automatically update here.

## How Does it Work?

When you run serverless package, the plugin will add an additional resource to
your list of resources. For the example above, it'll create a new parameter in
the SSM parameter store named `/subscriber/DatabaseName/DATABASE_NAME/customer`
(`/subscriber/<parameter-name>/<environment-variable-name>/<function-key>`).

The plugin will also install a single Lambda which subscribes to CloudWatch
Events for SSM Parameter Store updates. When a parameter is updated, it will use
this subscription parameters to update all functions which depend on that
parameter. Once an environment variable is updated in a Lambda, the Lambda will
be versioned. This means any new calls will use the new value but existing
running calls to the lambda will complete with the old value.

_NOTE:_ the change seems to take up to a 1 minute to take place depending on how
quickly CloudWatch fires off the event.
