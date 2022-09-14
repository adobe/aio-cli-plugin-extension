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
const rtLib = require('@adobe/aio-lib-runtime')
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-extension', { provider: 'debug' })
const path = require('path')
const LibConsoleCLI = require('@adobe/aio-cli-lib-console')
const { getToken, context } = require('@adobe/aio-lib-ims')
const { getCliEnv } = require('@adobe/aio-lib-env')
const { CLI } = require('@adobe/aio-lib-ims/src/context')
const eventsSdk = require('@adobe/aio-lib-events')
const ora = require('ora')
const inquirer = require('inquirer')
const prompt = inquirer.createPromptModule({ output: process.stderr })

const ENTP_INT_CERTS_FOLDER = 'entp-int-certs'
const AIO_CONFIG_WORKSPACE_SERVICES = 'project.workspace.details.services'
const CONSOLE_API_KEYS = {
  prod: 'aio-cli-console-auth',
  stage: 'aio-cli-console-auth-stage'
}
const PREFERRED_PROVIDERS_KEY = 'PREFERRED_PROVIDERS'
let rtClient

/**
 * Creates an instance of rtLib
 * Acts as a singleton
 *
 * @returns {*} - runtime lib client
 */
async function getRtClient () {
  if (rtClient !== undefined) {
    return rtClient
  }
  aioLogger.debug('Initializing runtime client')
  const runtimeConfig = coreConfig.get('runtime')

  rtClient = await rtLib.init({
    api_key: runtimeConfig.auth,
    namespace: runtimeConfig.namespace,
    apihost: runtimeConfig.apihost
  })
  return rtClient
}

/**
 * Checks if action with specified name exist in openwhisk
 *
 * @param {string} name - openwhisk action name
 * @returns {boolean} - true if action exists
 */
async function isActionExists (name) {
  const client = await getRtClient()

  try {
    await client.actions.get({ name: name })
  } catch (error) {
    return false
  }

  return true
}

/**
 * Checks if package with specified name exist in openwhisk
 *
 * @param {string} name - openwhisk package name
 * @returns {boolean} - true if package exists
 */
async function isPackageExists (name) {
  const client = await getRtClient()
  const packages = await client.packages.list()
  return packages.some(e => e.name === name)
}

/**
 * Creates a new package if needed. Optionally bind new package to existing one
 *
 * @param {string} packageName - new package name
 * @param {string} boundPackage - fully qualified package name of source package (e.g. /namespace/packageName)
 * @param {Array} params - array of openwhisk package params in [{key: '', value: ''}] format
 */
async function createPackageIfNotExists (packageName, boundPackage = undefined, params = []) {
  if (await isPackageExists(packageName)) {
    aioLogger.debug('Package ' + packageName + ' already exists. Skipping...')
    return
  }
  aioLogger.debug('Creating new package ' + packageName)
  const client = await getRtClient()
  const pkg = {}

  if (boundPackage !== undefined) {
    // Removing heading slash
    const cleanPackage = boundPackage.replace(/^\//, '')
    const parts = cleanPackage.split('/')
    // Last part is a package name, everything else is a package namespace
    const boundPackageName = parts.pop()
    const boundPackageNamespace = parts.join('/')

    pkg.binding = {
      namespace: boundPackageNamespace,
      name: boundPackageName
    }
  }

  pkg.parameters = params

  await client.packages.update({ name: packageName, package: pkg })
}

/**
 * Creates openwhisk sequence of actions
 *
 * @param {string} sequenceName - squence name
 * @param {Array} actions - array of action names
 * @param {{Object}} annotations - object that will be converted to annotations array
 * @param {string} web - 'yes' or 'no' - openwhisk web flag for actions
 */
async function createSequenceIfNotExists (sequenceName, actions, annotations, web = 'no') {
  const client = await getRtClient()

  if (await isActionExists(sequenceName)) {
    aioLogger.debug('Sequence  ' + sequenceName + ' already exists. Skipping...')
    return
  }
  client.actions.create({ name: sequenceName, sequence: actions, annotations, web: web })
}

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

  // Automatically select provider from PREFERRED_PROVIDERS env variable
  if (process.env[PREFERRED_PROVIDERS_KEY]) {
    const preferredProviders = process.env[PREFERRED_PROVIDERS_KEY].split(',')
    for (const currentPreferredProvider in preferredProviders) {
      const providerOverride = providers.find(e => e.id === preferredProviders[currentPreferredProvider])
      if (providerOverride) {
        return providerOverride
      }
    }
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
 * Setup I/O Events client and credentials
 *
 * Adds I/O Management permissions to current credentials if needed
 *
 * @param {*} project - project object
 * @param {*} workspace - workspace object
 * @param {*} options - hook's options
 * @returns {*} - events client
 */
async function setupEventsClient (project, workspace, options) {
  const projectConfig = coreConfig.get('project')
  const orgId = projectConfig.org.id
  const orgCode = projectConfig.org.ims_org_id
  const env = getCliEnv()
  await context.setCli({ 'cli.bare-output': true }, false) // set this globally
  const accessToken = await getToken(CLI)
  const cliObject = await context.getCli()
  const apiKey = CONSOLE_API_KEYS[env]

  const consoleCLI = await LibConsoleCLI.init({ accessToken: cliObject.access_token.token, env, apiKey: apiKey })
  const workspaceCreds = await consoleCLI.getFirstEntpCredentials(orgId, project.id, workspace)
  const client = await eventsSdk.init(orgCode, workspaceCreds.client_id, accessToken)

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

  return {
    client,
    workspaceCreds
  }
}

module.exports = {
  createSequenceIfNotExists,
  createPackageIfNotExists,
  setupEventsClient,
  findProviderByEvent,
  selectProvider
}
