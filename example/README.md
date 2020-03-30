# Example usage of serverless-parameter-subscriber

This is a simple example Serverless service demonstrating the use of the
`serverless-parameter-subscriber`. It deploys two simple functions which return
the value of the parameter named _ParamValue_.

## Deploying this example

You'll need to have [`serverless`](https://www.npmjs.com/package/serverless)
installed. To deploy, simply run:

```
$ npm install
$ sls deploy -s <stage>
```

## Updating parameters

First, let's see what value the function is returning.

```
$ sls invoke -s <stage> one
$ sls invoke -s <stage> two
```

You'll see both functions are returning the same value. To update a parameter;

1. Go to the Systems Manager in your AWS Console.
2. Open the Parameter Store tab on the left.
3. Type ParamValue in the search box and hit enter
4. Update the parameter to a different value

Now, let's run those functions again.

```
$ sls invoke -s <stage> one
$ sls invoke -s <stage> two
```

You should see both functions returning the new value. Note that it can take a
few seconds for all subscribing functions to update.
