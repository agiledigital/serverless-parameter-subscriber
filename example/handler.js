'use strict';

module.exports = {
  one: async event => {
    const val = process.env.ENV_VAR_ONE;
    console.log(`ENV_VAR_ONE = [${val}]`);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: 'ENV_VAR_ONE!',
          val,
        },
        null,
        2
      ),
    };
  },
  two: async event => {
    const val = process.env.ENV_VAR_TWO;
    console.log(`ENV_VAR_TWO = [${val}]`);
    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          message: 'ENV_VAR_TWO!',
          val,
        },
        null,
        2
      ),
    };
  },
}
