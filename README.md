## serverless-parameter-subscriber

Not working yet!

Processes the SSM parameter change event so that the dependent Lambda Function
will get the updated SSM parameter value.

Example:
The below setup must be done within your serverless project, we will have a
plugin to support the setup soon.
- Function Name: `myFunction`
- Function ENV: `MY_ENV`
- SSM Parameter Key: `myParam`
- Subscriber Parameter Key: `/subscriber/myParam/MY_ENV/myFunction`

For the above example setup, the `MY_ENV` value will be the value of `myParam`,
and this Lambda will update the `MY_ENV` environment variable based on the
change event from `myParam`. Search of what function to update is done based on
the subscriber parameter key path: `/subscriber/myParam`.
