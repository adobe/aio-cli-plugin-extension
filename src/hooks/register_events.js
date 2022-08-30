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

const AIO_CONFIG_EVENTS_LISTENERS = 'project.workspace.listeners'
const EVENTS_KEY = 'event-listener-for'

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
    for (const index in pkg.sequences) {
      if (!pkg.sequences[index].relations || !pkg.sequences[index].relations[EVENTS_KEY]) {
        continue
      }
      for (const eventIndex in pkg.sequences[index].relations[EVENTS_KEY]) {
        existingListeners.push(pkg.sequences[index].relations[EVENTS_KEY][eventIndex])
      }
    }
  })

  for (const index in appliedEvents) {
    if (existingListeners.includes(appliedEvents[index].event_type)) {
      continue
    }
    aioLogger.debug('Deleting registration with id: ' + appliedEvents[index].registration_id)
    try {
      await client.deleteWebhookRegistration(orgId, integrationId, appliedEvents[index].registration_id)
    } catch (error) {
      aioLogger.debug('Error deleting registration with id: ' + appliedEvents[index].registration_id)
      aioLogger.debug('Cleaning local records for registration with id: ' + appliedEvents[index].registration_id)
      const newAppliedEvents = appliedEvents.filter(e => e.event_type !== appliedEvents[index].event_type)
      await coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, newAppliedEvents, true)
      return
    }
    aioLogger.debug('Deleted registration with id: ' + appliedEvents[index].registration_id)
    const newAppliedEvents = appliedEvents.filter(e => e.event_type !== appliedEvents[index].event_type)
    await coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, newAppliedEvents, true)
  }
}

/**
 * Finds events and related callable OW entities (actions, sequences) in manifest
 *
 * @param {*} packages - A packages section from manifest
 * @yields
 */
function * parseEvents (packages) {
  const appliedEvents = coreConfig.get(AIO_CONFIG_EVENTS_LISTENERS) || []

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
        const isEventApplied = (appliedEvents.filter(e => e.event_type === currentEventType)).length > 0
        // Skip already applied event
        if (isEventApplied) {
          aioLogger.debug('This app is already subscribed to event ' + currentEventType)
          continue
        }

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
        const isEventApplied = (appliedEvents.filter(e => e.event_type === currentEventType)).length > 0
        // Skip already applied event
        if (isEventApplied) {
          aioLogger.debug('This app is already subscribed to event ' + currentEventType)
          continue
        }

        yield {
          eventType: currentEventType,
          packageName: pkgName,
          callableName: sequence
        }
      }
    }
  }
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

  if (['app:undeploy'].includes(options.Command.id)) {
    aioLogger.debug('Unsubscribing from all events')
    await deleteObsoleteRegistrations([], client, projectConfig.org.id, workspaceIntegration.id)
    return
  }

  const appliedEvents = coreConfig.get(AIO_CONFIG_EVENTS_LISTENERS) || []

  for (const { eventType, packageName, callableName } of parseEvents(fullConfig.application.manifest.full.packages)) {
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
      events_of_interest: [
        {
          provider_id: currentProvider.id,
          event_code: eventType
        }
      ]
    }

    const registration = await client.createWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, body)

    appliedEvents.push({
      event_type: eventType,
      registration_id: registration.registration_id
    })

    coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, appliedEvents, true)
  }

  await deleteObsoleteRegistrations(fullConfig.application.manifest.full.packages, client, projectConfig.org.id, workspaceIntegration.id)

  if (['app:run'].includes(options.Command.id)) {
    // TODO: Remove the following hack after app builder plugin fix. The reason of this hack is process.exit call in app builder plugin
    const orginialExit = process.exit
    process.exit = () => {}
    process.on('SIGINT', async () => {
      await deleteObsoleteRegistrations([], client, projectConfig.org.id, workspaceIntegration.id)
      process.exit = orginialExit
    })
  }
}

module.exports = hook
