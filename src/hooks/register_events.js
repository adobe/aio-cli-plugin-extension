/*
Copyright 2022 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/
const path = require('path')
const coreConfig = require('@adobe/aio-lib-core-config')
const { v4: uuidv4 } = require('uuid')
const loadConfig = require('@adobe/aio-cli-lib-app-config')
const { getToken, context } = require('@adobe/aio-lib-ims')
const { getCliEnv } = require('@adobe/aio-lib-env')
const { CLI } = require('@adobe/aio-lib-ims/src/context')
const LibConsoleCLI = require('@adobe/aio-cli-lib-console')
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-extension', { provider: 'debug' })
const eventsSdk = require('@adobe/aio-lib-events')
const process = require('process')
const ora = require('ora')
const inquirer = require('inquirer')
const prompt = inquirer.createPromptModule({ output: process.stderr })
const { createSequenceIfNotExists, createPackageIfNotExists } = require('../utils')

const ENTP_INT_CERTS_FOLDER = 'entp-int-certs'
const CONSOLE_API_KEYS = {
  prod: 'aio-cli-console-auth',
  stage: 'aio-cli-console-auth-stage'
}
const AIO_CONFIG_WORKSPACE_SERVICES = 'project.workspace.details.services'
const AIO_CONFIG_EVENTS_LISTENERS = 'project.workspace.listeners'
const EVENTS_KEY = 'event-listener-for'

const providerCache = []

/**
 * Find providers by event code
 *
 * @param {*} client - Adobe events sdk client
 * @param {string} orgId - Adobe org id
 * @param {string} event - event type
 * @returns {*} - provider(s) details
 */
async function findProviderByEvent (client, orgId, event) {
  if (providerCache.length === 0) {
    aioLogger.debug('Loading provider infromation')
    const spinner = ora()
    spinner.start('Fetching event providers information')
    const response = await client.getAllProviders(orgId)
    const providers = response._embedded.providers

    for (const provider in providers) {
      const newProvider = {
        id: providers[provider].id,
        label: providers[provider].label,
        instance_id: providers[provider].instance_id
      }

      const providerInfo = await client.getAllEventMetadataForProvider(providers[provider].id)

      newProvider.events = providerInfo._embedded.eventmetadata.map(e => e.event_code)
      providerCache.push(newProvider)
    }
    spinner.stop()
  }

  const result = providerCache.filter(function (e) {
    const hasEvent = e.events.filter(e => e === event)
    return hasEvent.length > 0
  })

  if (result.length > 0) {
    aioLogger.debug('Found provider(s) by event code ' + event)
    return result
  }
  aioLogger.debug('Provider for event code ' + event + ' is not found in org')
  throw new Error('Event provider with event code ' + event + ' doesn\'t exist in your organization ' + orgId)
}

/**
 * Asks user for provider
 *
 * @param {*} providers - list of filtered providers
 * @param {string} eventType - event type registered for provider
 * @returns {*} - returns provider details based on user input
 */
async function selectProvider (providers, eventType) {
  if (providers.length === 0) {
    throw new Error('Event providers list is empty. You need to specify at least one provider to select from.')
  }
  if (providers.length === 1) {
    aioLogger.debug('There is a single matching event provider found for event')
    return providers[0]
  }
  aioLogger.debug('Multiple event providers found for the event code. Initiating selection dialog...')
  const message = 'We found multiple event providers for event type ' + eventType + '. Please select provider for this project'
  const choices = providers.map(e => { return { name: e.label, value: e.id, instance_id: e.instance_id } })

  const result = await prompt([
    {
      type: 'list',
      name: 'res',
      message,
      choices
    }
  ])

  return providers.find(e => e.id === result.res)
}

/**
 * Deletes applied registrations which are not present in action's definitions
 *
 * @param {*} packages - packages declaration from app builder manifest
 * @param {*} client - event api client from sdk
 * @param {string} orgId - Adobe org id
 * @param {string} integrationId - id of JWT integration
 */
async function deleteObsoleteRegistrations (packages, client, orgId, integrationId) {
  const appliedEvents = coreConfig.get(AIO_CONFIG_EVENTS_LISTENERS) || []
  const existingListeners = []
  aioLogger.debug('Processing deleted subscriptions...')

  Object.entries(packages).forEach(async ([pkgName, pkg]) => {
    for (const index in pkg.actions) {
      if (!pkg.actions[index].relations || !pkg.actions[index].relations[EVENTS_KEY]) {
        continue
      }
      for (const eventIndex in pkg.actions[index].relations[EVENTS_KEY]) {
        existingListeners.push(pkg.actions[index].relations[EVENTS_KEY][eventIndex])
      }
    }
  })

  for (const index in appliedEvents) {
    if (existingListeners.includes(appliedEvents[index].event_type)) {
      continue
    }
    aioLogger.debug('Deleting registration with id: ' + appliedEvents[index].registration_id)
    await client.deleteWebhookRegistration(orgId, integrationId, appliedEvents[index].registration_id)
    aioLogger.debug('Deleted registration with id: ' + appliedEvents[index].registration_id)
    const newAppliedEvents = appliedEvents.filter(e => e.event_type !== appliedEvents[index].event_type)
    coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, newAppliedEvents, true)
  }
}

const hook = async function (options) {
  // Empty aio run
  if (!options.Command) {
    return
  }

  if (!['app:deploy', 'app:undeploy'].includes(options.Command.id)) {
    aioLogger.debug('App builder extension plugin works only for app:deploy command. Skipping...')
    return
  }

  const appConfig = await loadConfig({})
  const fullConfig = appConfig.all

  // load console configuration from .aio and .env files
  const projectConfig = coreConfig.get('project')
  if (!projectConfig) {
    throw new Error('Incomplete .aio configuration, please import a valid Adobe Developer Console configuration via `aio app use` first.')
  }

  const orgId = projectConfig.org.id
  const orgCode = projectConfig.org.ims_org_id
  const project = { name: projectConfig.name, id: projectConfig.id }
  const workspace = { name: projectConfig.workspace.name, id: projectConfig.workspace.id }

  const env = getCliEnv()
  await context.setCli({ 'cli.bare-output': true }, false) // set this globally
  const accessToken = await getToken(CLI)
  const cliObject = await context.getCli()
  const apiKey = CONSOLE_API_KEYS[env]
  const consoleCLI = await LibConsoleCLI.init({ accessToken: cliObject.access_token.token, env, apiKey: apiKey })
  const workspaceCreds = await consoleCLI.getFirstEntpCredentials(orgId, project.id, workspace)
  const client = await eventsSdk.init(orgCode, workspaceCreds.client_id, accessToken)
  const workspaceIntegration = projectConfig.workspace.details.credentials && projectConfig.workspace.details.credentials.find(c => c.integration_type === 'service')

  const supportedServices = await consoleCLI.getEnabledServicesForOrg(orgId)
  const currentServiceProperties = await consoleCLI.getServicePropertiesFromWorkspace(
    orgId,
    project.id,
    workspace,
    supportedServices
  )

  const isIOManagementPresent = currentServiceProperties.filter(function (item) {
    return item.sdkCode === 'AdobeIOManagementAPISDK'
  })

  if (isIOManagementPresent.length === 0) {
    aioLogger.debug('IO Management API is not available to aio cli. Adding the service...')
    currentServiceProperties.push({
      name: 'I/O Management API',
      sdkCode: 'AdobeIOManagementAPISDK',
      roles: null,
      licenseConfigs: null
    })

    await consoleCLI.subscribeToServices(
      orgId,
      project,
      workspace,
      path.join(options.config.dataDir, ENTP_INT_CERTS_FOLDER),
      currentServiceProperties
    )

    const serviceConfig = currentServiceProperties.map(s => ({
      name: s.name,
      code: s.sdkCode
    }))
    coreConfig.set(AIO_CONFIG_WORKSPACE_SERVICES, serviceConfig, true)
  } else {
    aioLogger.debug('Current aio cli token allows access to IO management API')
  }

  if (['app:undeploy'].includes(options.Command.id)) {
    aioLogger.debug('Unsubscribing from all events')
    await deleteObsoleteRegistrations([], client, projectConfig.org.id, workspaceIntegration.id)
    return
  }

  const appliedEvents = coreConfig.get(AIO_CONFIG_EVENTS_LISTENERS) || []
  const packages = fullConfig.application.manifest.full.packages
  for (const packageIndex in packages) {
    const pkg = packages[packageIndex]
    const pkgName = packageIndex

    for (const action in pkg.actions) {
      aioLogger.debug('Processing event types defined for action ' + action)
      // Skip actions with empty listeners node
      if (!pkg.actions[action].relations || !pkg.actions[action].relations[EVENTS_KEY]) {
        continue
      }

      for (const eventCode in pkg.actions[action].relations[EVENTS_KEY]) {
        const currentEventType = pkg.actions[action].relations[EVENTS_KEY][eventCode]
        const isEventApplied = (appliedEvents.filter(e => e.event_type === currentEventType)).length > 0

        const providers = await findProviderByEvent(client, orgId, currentEventType)
        const currentProvider = await selectProvider(providers, currentEventType)

        const registrationName = 'extension auto registration ' + uuidv4()

        // For private event listeners we have to create multiple additional actions
        await createPackageIfNotExists('bound_package', '/adobe/acp-event-handler-3.0.0', [
          {
            key: 'recipient_client_id',
            value: workspaceCreds.client_id
          }
        ])

        await createPackageIfNotExists('acp')

        const customHandlerName = '3rd_party_custom_events_' + orgCode + '_' + currentProvider.instance_id + '_' + currentEventType + '_' + pkgName + action

        await createSequenceIfNotExists(
          '/' + fullConfig.application.ow.namespace + '/acp/sync_event_handler',
          ['/' + fullConfig.application.ow.namespace + '/bound_package/handler'], {
            final: 'false',
            event_handler_sequence: 'sync_event_handler',
            'web-export': true,
            'raw-http': true
          },
          'yes'
        )

        await createSequenceIfNotExists(
          customHandlerName,
          [
            '/' + fullConfig.application.ow.namespace + '/bound_package/validate_action',
            '/' + fullConfig.application.ow.namespace + '/' + pkgName + '/' + action
          ], {
            user_sequence: 'true',
            'raw-http': 'true'
          }
        )

        // Skip event types that already have subscription
        if (isEventApplied) {
          aioLogger.debug('This app is already subscribed to event ' + currentEventType)
          continue
        }

        const actionUrl = fullConfig.application.ow.apihost + '/api/' + fullConfig.application.ow.apiversion + '/web/' +
          fullConfig.application.ow.namespace + '/acp/sync_event_handler?sync=true&id=' + pkgName + action

        const body = {
          name: registrationName,
          client_id: workspaceCreds.client_id,
          description: registrationName,
          delivery_type: 'WEBHOOK',
          webhook_url: actionUrl,
          events_of_interest: [
            {
              provider_id: currentProvider.id,
              event_code: currentEventType
            }
          ]
        }

        const registration = await client.createWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, body)

        appliedEvents.push({
          event_type: currentEventType,
          registration_id: registration.registration_id
        })

        coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, appliedEvents, true)
      }
    }
  }

  await deleteObsoleteRegistrations(fullConfig.application.manifest.full.packages, client, projectConfig.org.id, workspaceIntegration.id)
}

module.exports = hook
