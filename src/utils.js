const coreConfig = require('@adobe/aio-lib-core-config')
const rtLib = require('@adobe/aio-lib-runtime')
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-extension', { provider: 'debug' })

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

module.exports = {
  createSequenceIfNotExists,
  createPackageIfNotExists
}
