# aio-cli-plugin-extension
Aio cli plugin that converts your App Builder project in an Adobe extension. Such extensions are able to request and modify Adobe resources according to extension's needs (e.g. register I/O Events based on manifest requirements)

## Prerequisites
- `nodejs` (v14 or higher) and `npm` installed locally - https://nodejs.org/en/
- `aio` command line tool - https://github.com/adobe/aio-cli, https://developer.adobe.com/runtime/docs/guides/tools/cli_install/
- Project in Adobe developer console
- Credentials in the project from previous point

## Installation
Launch `aio plugins install @adobe/aio-cli-plugin-extension` CLI command

## I/O Events support
Define the event types you want to receive in your action in `app.config.yaml` file like following (`event_listener_for` section):
```
application:
  actions: actions
  web: web-src
  runtimeManifest:
    packages:
      appbuilder:
        license: Apache-2.0
        actions:
          generic:
            function: actions/generic/index.js
            web: 'no'
            runtime: 'nodejs:14'
            inputs:
              LOG_LEVEL: debug
            annotations:
              require-adobe-auth: false
            relations:
              event-listener-for:
                - {{YOUR_EVENT_TYPE}}
```
Replace `{{YOUR_EVENT_TYPE}}` with your event and `actions/generic/index.js` with path to your function.

Supported OpenWhisk entities: actions and sequences.

### Development
We recommend using a separate workspace for development purposes, so please create/choose an existing workspace for development. Switch to the development workspace using `aio app use` CLI command.

The plugin subscribes to events during development session (`aio app run`) and cleanup subscriptions on CTRL+C.

Do not forget to switch back to production workspace when you are ready to deploy the code to production.

### Usage in CI/CD
When your environment contains multiple suitable event providers, this plugin asks the user to select one manually. This behavior works for many user scenarios, but it may cause issues in CI/CD environment. In such cases, `PREFERRED_PROVIDERS` will help to specify a list of provider ids that will be selected automatically. Example: `PREFERRED_PROVIDERS=c021fed7-54f3-4137-b7d0-1f3abb2e9902,dfa1319c-83ab-406e-869a-067cf89c65ba aio app deploy`

## Security
We recommend to declare all your actions as non-web actions. This way only Adobe IO Events will be able to deliver data to your action.

## Updating
Launch `aio plugins update` console command

## Contributing

Contributions are welcomed! Read the [Contributing Guide](CONTRIBUTING.md) for more information.

## Licensing

This project is licensed under the Apache V2 License. See [LICENSE](LICENSE) for more information.
