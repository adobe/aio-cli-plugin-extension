# aio-cli-plugin-extension
Aio cli plugin that converts your App Builder project in an Adobe extension. Such extensions are able to request and modify Adobe resources according to extension's needs (e.g. register I/O Events based on manifest requirements)

## Installation
TBD

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
            web: 'yes'
            runtime: 'nodejs:14'
            inputs:
              LOG_LEVEL: debug
            annotations:
              require-adobe-auth: false
            event_listener_for:
              - {{YOUR_EVENT_TYPE}}
```
Replace `{{YOUR_EVENT_TYPE}}` with your event and `actions/generic/index.js` with path to your function

## Contributing

Contributions are welcomed! Read the [Contributing Guide](CONTRIBUTING.md) for more information.

## Licensing

This project is licensed under the Apache V2 License. See [LICENSE](LICENSE) for more information.
