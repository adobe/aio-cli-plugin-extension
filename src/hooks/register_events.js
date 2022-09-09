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
const coreConfig = require('@adobe/aio-lib-core-config')
const { v4: uuidv4 } = require('uuid')
const loadConfig = require('@adobe/aio-cli-lib-app-config')
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-extension', { provider: 'debug' })
const process = require('process')
const { createSequenceIfNotExists, createPackageIfNotExists, setupEventsClient, findProviderByEvent, selectProvider } = require('../utils')
const EVENTS_KEY = 'event-listener-for'

/**
 * Deletes applied registrations which are not present in action's definitions
 *
 * @param {*} packages - packages declaration from app builder manifest
 * @param {*} registrations - a list of existing registrations
 * @param {*} client - event api client from sdk
 * @param {string} orgId - Adobe org id
 * @param {string} integrationId - id of JWT integration
 */
async function deleteObsoleteRegistrations (packages, registrations, client, orgId, integrationId) {
  aioLogger.debug('Processing deleted subscriptions...')

  const isStillListen = function (eventType, fullActionName) {
    const parts = fullActionName.split('/')
    const packageName = parts[0]
    const actionName = parts[1]

    if (packages[packageName]) {
      if (packages[packageName].actions &&
        packages[packageName].actions[actionName] &&
        packages[packageName].actions[actionName].relations &&
        packages[packageName].actions[actionName].relations['event-listener-for']
      ) {
        for (const eventIndex in packages[packageName].actions[actionName].relations['event-listener-for']) {
          if (packages[packageName].actions[actionName].relations['event-listener-for'][eventIndex] === eventType) {
            return true
          }
        }
      }

      if (packages[packageName].sequences &&
        packages[packageName].sequences[actionName] &&
        packages[packageName].sequences[actionName].relations &&
        packages[packageName].sequences[actionName].relations['event-listener-for']
      ) {
        for (const eventIndex in packages[packageName].sequences[actionName].relations['event-listener-for']) {
          if (packages[packageName].sequences[actionName].relations['event-listener-for'][eventIndex] === eventType) {
            return true
          }
        }
      }
    }

    return false
  }

  for (const registration in registrations) {
    for (const event in registrations[registration].events_of_interest) {
      if (!isStillListen(
        registrations[registration].events_of_interest[event].event_code, registrations[registration].runtime_action
      )) {
        try {
          await client.deleteWebhookRegistration(orgId, integrationId, registrations[registration].registration_id)
          aioLogger.debug('Deleted registration with id: ' + registrations[registration].registration_id)
        } catch (error) {
          aioLogger.debug('Error deleting registration with id: ' + registrations[registration].registration_id)
          continue
        }
      }
    }
  }
}

/**
 * Finds events and related callable OW entities (actions, sequences) in manifest
 *
 * @param {*} packages - A packages section from manifest
 * @yields
 */
function * parseEvents (packages) {
  for (const pkgName in packages) {
    const pkg = packages[pkgName]
    for (const action in pkg.actions) {
      aioLogger.debug('Processing event types defined for action ' + action)
      // Skip actions with empty listeners node
      if (!pkg.actions[action].relations || !pkg.actions[action].relations[EVENTS_KEY]) {
        continue
      }

      for (const eventCode in pkg.actions[action].relations[EVENTS_KEY]) {
        const currentEventType = pkg.actions[action].relations[EVENTS_KEY][eventCode]

        yield {
          eventType: currentEventType,
          packageName: pkgName,
          callableName: action
        }
      }
    }
    for (const sequence in pkg.sequences) {
      aioLogger.debug('Processing event types defined for sequence ' + sequence)
      // Skip actions with empty listeners node
      if (!pkg.sequences[sequence].relations || !pkg.sequences[sequence].relations[EVENTS_KEY]) {
        continue
      }

      for (const eventCode in pkg.sequences[sequence].relations[EVENTS_KEY]) {
        const currentEventType = pkg.sequences[sequence].relations[EVENTS_KEY][eventCode]

        yield {
          eventType: currentEventType,
          packageName: pkgName,
          callableName: sequence
        }
      }
    }
  }
}

/**
 * Check if registration exists for specified action/sequence
 *
 * @param {*} registrations - a list of existing registrations
 * @param {*} fullCallableName - namespace + action/sequence name
 * @param {*} eventType - event type
 * @returns {boolean} - true if registration exists
 */
function isEventApplied (registrations, fullCallableName, eventType) {
  for (const registrationIndex in registrations) {
    if (registrations[registrationIndex].runtime_action !== fullCallableName) {
      continue
    }
    for (const eventsIndex in registrations[registrationIndex].events_of_interest) {
      if (registrations[registrationIndex].events_of_interest[eventsIndex].event_code === eventType) {
        return true
      }
    }
  }
  return false
}

const hook = async function (options) {
  // Empty aio run
  if (!options.Command) {
    return
  }

  if (!['app:deploy', 'app:undeploy', 'app:run'].includes(options.Command.id)) {
    aioLogger.debug('App builder extension plugin works only for app:deploy and app:run commands. Skipping...')
    return
  }

  const appConfig = await loadConfig({})
  const fullConfig = appConfig.all

  // load console configuration from .aio and .env files
  const projectConfig = coreConfig.get('project')
  if (!projectConfig) {
    throw new Error('Incomplete .aio configuration, please import a valid Adobe Developer Console configuration via `aio app use` first.')
  }

  const project = { name: projectConfig.name, id: projectConfig.id }
  const workspace = { name: projectConfig.workspace.name, id: projectConfig.workspace.id }
  const workspaceIntegration = projectConfig.workspace.details.credentials && projectConfig.workspace.details.credentials.find(c => c.integration_type === 'service')

  const { client, workspaceCreds } = await setupEventsClient(project, workspace, options)
  const registrations = await client.getAllWebhookRegistrations(projectConfig.org.id, workspaceIntegration.id)

  if (options.Command.id === 'app:undeploy') {
    aioLogger.debug('Unsubscribing from all events')
    for (const registration in registrations) {
      await client.deleteWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, registrations[registration].registration_id)
    }
    return
  }

  for (const { eventType, packageName, callableName } of parseEvents(fullConfig.application.manifest.full.packages)) {
    if (isEventApplied(registrations, packageName + '/' + callableName, eventType)) {
      continue
    }

    const providers = await findProviderByEvent(client, projectConfig.org.id, eventType)
    const currentProvider = await selectProvider(providers, eventType)
    const registrationName = 'extension auto registration ' + uuidv4()

    // For private event listeners we have to create multiple additional actions and packages
    await createPackageIfNotExists('bound_package', '/adobe/acp-event-handler-3.0.0', [
      {
        key: 'recipient_client_id',
        value: workspaceCreds.client_id
      }
    ])

    await createPackageIfNotExists('acp')

    const customHandlerName = '3rd_party_custom_events_' + projectConfig.org.ims_org_id + '_' +
      currentProvider.instance_id + '_' + eventType + '_' + packageName + callableName

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
        '/' + fullConfig.application.ow.namespace + '/' + packageName + '/' + callableName
      ], {
        user_sequence: 'true',
        'raw-http': 'true'
      }
    )

    const actionUrl = fullConfig.application.ow.apihost + '/api/' + fullConfig.application.ow.apiversion + '/web/' +
      fullConfig.application.ow.namespace + '/acp/sync_event_handler?sync=true&id=' + packageName + callableName

    const body = {
      name: registrationName,
      client_id: workspaceCreds.client_id,
      description: registrationName,
      delivery_type: 'WEBHOOK',
      webhook_url: actionUrl,
      runtime_action: packageName + '/' + callableName,
      events_of_interest: [
        {
          provider_id: currentProvider.id,
          event_code: eventType
        }
      ]
    }

    const registration = await client.createWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, body)
    registrations.push(registration)
  }

  await deleteObsoleteRegistrations(fullConfig.application.manifest.full.packages, registrations, client, projectConfig.org.id, workspaceIntegration.id)

  if (['app:run'].includes(options.Command.id)) {
    // TODO: Remove the following hack after app builder plugin fix. The reason of this hack is process.exit call in app builder plugin
    const orginialExit = process.exit
    process.exit = () => {}
    process.on('SIGINT', async () => {
      aioLogger.debug('End of dev session. Unsubscribing from all events...')
      for (const registration in registrations) {
        await client.deleteWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, registrations[registration].registration_id)
      }
      process.exit = orginialExit
    })
  }
}

module.exports = hook
