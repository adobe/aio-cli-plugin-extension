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
const path = require('path');
const coreConfig = require('@adobe/aio-lib-core-config');
const { v4: uuidv4 } = require('uuid');
const loadConfig = require('@adobe/aio-cli-lib-app-config');
const { getToken, context } = require('@adobe/aio-lib-ims');
const { getCliEnv } = require('@adobe/aio-lib-env')
const { IMS, CLI, CONFIG, CONTEXTS, CURRENT } = require('@adobe/aio-lib-ims/src/context')
const LibConsoleCLI = require('@adobe/aio-cli-lib-console');
const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-extension', { provider: 'debug' })
const { Command, flags } = require('@oclif/command');
const eventsSdk = require('@adobe/aio-lib-events');
const getUrlCommand = require('@adobe/aio-cli-plugin-app/src/commands/app/get-url');
const process = require('process');
const ora = require('ora');
const inquirer = require('inquirer');
const prompt = inquirer.createPromptModule({ output: process.stderr });


const ENTP_INT_CERTS_FOLDER = 'entp-int-certs';
const CONSOLE_API_KEYS = {
    prod: 'aio-cli-console-auth',
    stage: 'aio-cli-console-auth-stage'
};
const AIO_CONFIG_WORKSPACE_SERVICES = 'project.workspace.details.services';
const AIO_CONFIG_EVENTS_LISTENERS = 'project.workspace.listeners';

const providerCache = [];

async function findProviderByEvent(client, orgId, event) {
    if (providerCache.length == 0) {
        aioLogger.debug('Loading provider infromation');
        const spinner = ora();
        spinner.start('Fetching event providers information');
        const response = await client.getAllProviders(orgId);
        const providers = response._embedded.providers;
        
        for (provider in providers) {
            const newProvider = { 
                id: providers[provider].id,
                label: providers[provider].label
            };
            
            const providerInfo = await client.getAllEventMetadataForProvider(providers[provider].id);
            newProvider.events = providerInfo._embedded.eventmetadata.map(e => e.event_code);
            providerCache.push(newProvider);
        }
        spinner.stop();
    }

    const result = providerCache.filter(function (e) {
        const hasEvent = e.events.filter(e => e == event);
        return hasEvent.length > 0;
    });
    
    if (result.length > 0) {
        aioLogger.debug('Found provider(s) by event code ' + event);
        return result;
    }
    aioLogger.debug('Provider for event code ' + event + ' is not found in org');
    throw new Error('Event provider with event code ' + event + ' doesn\'t exist in your organization ' + orgId);
}

async function selectProvider(providers, eventType) {
    if (providers.length == 0) {
        throw new Error('Event providers list is empty. You need to specify at least one provider to select from.');
    }
    if (providers.length == 1) {
        aioLogger.debug('There is a single matching event provider found for event');
        return {res: providers[0].id};
    }
    aioLogger.debug('Multiple event providers found for the event code. Initiating selection dialog...');
    const message = 'We found multiple event providers for event type ' + eventType + '. Please select provider for this project'
    const choices = providers.map(e => { return {name: e.label, value: e.id}});
    return await prompt([
      {
        type: 'list',
        name: 'res',
        message,
        choices
      }
    ])
    
}

const hook = async function (options) {
    if ("app:deploy" != options.Command.id) {
        aioLogger.debug('App builder extension plugin works only for app:deploy command. Skipping...');
        return;
    }
    
    const appBuilderConfig = loadConfig({}).all.application.manifest.full.packages.appbuilder || {};
    const actions = appBuilderConfig.actions || {};
    
    if (!actions) {
        aioLogger.debug('No app builder actions are defined. Skipping...');
        return;
    }
    
    // load console configuration from .aio and .env files
    const projectConfig = coreConfig.get('project')
    if (!projectConfig) {
      throw new Error('Incomplete .aio configuration, please import a valid Adobe Developer Console configuration via `aio app use` first.')
    }
    const orgId = projectConfig.org.id;
    const orgCode = projectConfig.org.ims_org_id;
    const project = { name: projectConfig.name, id: projectConfig.id }
    const workspace = { name: projectConfig.workspace.name, id: projectConfig.workspace.id }
    
    const env = getCliEnv();
    await context.setCli({ 'cli.bare-output': true }, false) // set this globally
    const accessToken = await getToken(CLI)
    const cliObject = await context.getCli();
    //const integrationCredentials = (await context.get(workspace.name))
    const apiKey = CONSOLE_API_KEYS[env];
    // const apiKey = 'c1640aef40194c6daac5cf2aad35abe3';

    const consoleCLI = await LibConsoleCLI.init({ accessToken: cliObject.access_token.token, env, apiKey: apiKey });
    // const consoleCLI = await LibConsoleCLI.init({ accessToken: cliObject.access_token.token, env, apiKey: workspaceCreds.client_id });
    const workspaceCreds = await consoleCLI.getFirstEntpCredentials(orgId, project.id, workspace);
    
    const supportedServices = await consoleCLI.getEnabledServicesForOrg(orgId)
    const currentServiceProperties = await consoleCLI.getServicePropertiesFromWorkspace(
        orgId,
        project.id,
        workspace,
        supportedServices
    );
    
    const isIOManagementPresent = currentServiceProperties.filter(function(item) {
        return item.sdkCode == 'AdobeIOManagementAPISDK';
    });

    if (isIOManagementPresent.length == 0) {
        aioLogger.debug('IO Management API is not available to aio cli. Adding the service...');
        currentServiceProperties.push({
            name: 'I/O Management API',
            sdkCode: 'AdobeIOManagementAPISDK',
            roles: null,
            licenseConfigs: null
        });

        await consoleCLI.subscribeToServices(
            orgId,
            project,
            workspace,
            path.join(options.config.dataDir, ENTP_INT_CERTS_FOLDER),
            currentServiceProperties
        );
    
        const serviceConfig = currentServiceProperties.map(s => ({
            name: s.name,
            code: s.sdkCode
          }));
        coreConfig.set(AIO_CONFIG_WORKSPACE_SERVICES, serviceConfig, true);
    } else {
        aioLogger.debug('Current aio cli token allows to access IO management API');
    }
   
    const client = await eventsSdk.init(orgCode, workspaceCreds.client_id, accessToken);
    const workspaceIntegration = projectConfig.workspace.details.credentials && projectConfig.workspace.details.credentials.find(c => c.integration_type === 'service')

    aioLogger.debug('Getting runtime action urls from get-url command');
    // Temporary removing console output to make clean UX
    const tempBackup = process.stdout.write
    process.stdout.write = function() {}
    const urls = await getUrlCommand.run(['--json']);
    // Restoring console output function
    process.stdout.write = tempBackup
    // coreConfig.set(AIO_CONFIG_WORKSPACE_SERVICES, serviceConfig, true);
    const appliedEvents = coreConfig.get(AIO_CONFIG_EVENTS_LISTENERS) || [];
    for (const action in actions) {
        aioLogger.debug('Processing event types defined for action ' + action);
        if ('event_listener_for' in actions[action]) {
            for (eventCode in actions[action].event_listener_for) {
                if (appliedEvents.includes(actions[action].event_listener_for[eventCode])) {
                    aioLogger.debug('This app is already subscribed to event ' + actions[action].event_listener_for[eventCode]);
                    continue;
                }
                appliedEvents.push(actions[action].event_listener_for[eventCode]);
                const providers = await findProviderByEvent(client, orgId, actions[action].event_listener_for[eventCode]);
                const providerId = await selectProvider(providers, actions[action].event_listener_for[eventCode]);
                const registrationName = "extension auto registration " + uuidv4();
                
                const body = {
                    "name": registrationName,
                    "client_id": workspaceCreds.client_id,
                    "description": registrationName,
                    "delivery_type": "WEBHOOK_BATCH",
                    "webhook_url": urls.runtime[action],
                    "events_of_interest": [
                        {
                            "provider_id": providerId.res,
                            "event_code": actions[action].event_listener_for[eventCode]
                        }
                    ]
                };
                
                const registration = await client.createWebhookRegistration(projectConfig.org.id, workspaceIntegration.id, body);
                coreConfig.set(AIO_CONFIG_EVENTS_LISTENERS, appliedEvents, true);
            } 
        }
    }
}

module.exports = hook;