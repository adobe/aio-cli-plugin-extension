jest.mock('@adobe/aio-lib-core-config')
jest.mock('@adobe/aio-cli-lib-app-config')
jest.mock('@adobe/aio-lib-env')
jest.mock('@adobe/aio-lib-ims')
jest.mock('@adobe/aio-cli-lib-console')
jest.mock('@adobe/aio-lib-events')
jest.mock('@adobe/aio-lib-runtime')
jest.mock('inquirer')

const coreConfigMock = require('@adobe/aio-lib-core-config')
const loadConfig = require('@adobe/aio-cli-lib-app-config')
const { getCliEnv } = require('@adobe/aio-lib-env')
const { getToken, context } = require('@adobe/aio-lib-ims')
const LibConsoleCLI = require('@adobe/aio-cli-lib-console')
const eventsSdk = require('@adobe/aio-lib-events')
const rtLib = require('@adobe/aio-lib-runtime')
const inquirer = require('inquirer')

const prompt = jest.fn(() => {})
inquirer.createPromptModule.mockReturnValue(prompt)

const deleteWebhookRegistration = jest.fn(() => undefined)
const getAllProviders = jest.fn(() => undefined)
const getAllEventMetadataForProvider = jest.fn(() => undefined)
const createWebhookRegistration = jest.fn(() => {
  return {
    registration_id: 'test_registration_id'
  }
})

const eventsClient = {
  deleteWebhookRegistration: deleteWebhookRegistration,
  getAllProviders: getAllProviders,
  getAllEventMetadataForProvider: getAllEventMetadataForProvider,
  createWebhookRegistration: createWebhookRegistration
}

const serviceProperties = jest.fn(() => [])

const consoleCli = {
  getFirstEntpCredentials: jest.fn(() => {
    return {

    }
  }),
  getEnabledServicesForOrg: jest.fn(() => []),
  getServicePropertiesFromWorkspace: serviceProperties,
  subscribeToServices: jest.fn(() => [])
}

const rtClient = {
  packages: {
    list: jest.fn(() => []),
    update: jest.fn(() => true)
  },
  actions: {
    get: jest.fn(() => {}),
    create: jest.fn(() => true)
  }
}

const hook = require('../src/hooks/register_events')
const expect = require('expect')

beforeEach(() => {
  coreConfigMock.get.mockReset()

  rtLib.init.mockResolvedValue(rtClient)

  coreConfigMock.set.mockReturnValue(true)
  coreConfigMock.get.mockReturnValue({ globalConfig: 'seems-legit' })
  loadConfig.mockResolvedValue({
    all: {
      application: {
        manifest: {
          full: {
            packages: []
          }
        }
      }
    }
  })
  getCliEnv.mockResolvedValue('prod')
  getToken.mockResolvedValue('token mock')
  context.getCli.mockResolvedValue({ access_token: { token: 'token mock' }})
  eventsSdk.init.mockResolvedValue(eventsClient)
  coreConfigMock.get.mockReturnValueOnce({
    id: '123',
    project: undefined,
    projectConfig: {
      id: '123456789',
      name: 'test project'
    },
    org: {
      id: 'testid',
      ims_org_id: 'test@Adobe.org'
    },
    workspace: {
      name: 'Stage',
      id: 'workspace123',
      details: {
        credentials: [{
          integration_type: 'service',
          id: 'test_credentials_id'
        }]
      }
    }
  }).mockReturnValueOnce([])
  .mockReturnValueOnce([])

  LibConsoleCLI.init.mockResolvedValue(consoleCli)
  consoleCli.subscribeToServices.mockReset()
  serviceProperties.mockResolvedValue([])
  createWebhookRegistration.mockClear()

  getAllProviders.mockResolvedValue({
    _embedded: {
      providers: [
        {
          id: 'test_provider_id',
          label: 'test provider label',
          instance_id: 'test_provider_instance_id'
        },
        {
          id: 'test_provider_id2',
          label: 'test provider label2',
          instance_id: 'test_provider_instance_id2'
        },
        {
          id: 'test_provider_id3',
          label: 'test provider label3',
          instance_id: 'test_provider_instance_id3'
        }
      ]
    }
  })

  getAllEventMetadataForProvider.mockResolvedValueOnce({
    _embedded: {
      eventmetadata: [
        {
          event_code: 'test_event_type'
        }
      ]
    }
  }).mockResolvedValueOnce({
    _embedded: {
      eventmetadata: [
        {
          event_code: 'test_event_type2'
        }
      ]
    }
  }).mockResolvedValueOnce({
    _embedded: {
      eventmetadata: [
        {
          event_code: 'test_event_type2'
        }
      ]
    }
  })

  serviceProperties.mockResolvedValue([{
    sdkCode: 'AdobeIOManagementAPISDK'
  }])
})


describe('Extensions plugin hook', () => {
  test('Doesn\'t work on --help command', async () => {
    hook({})
    expect(coreConfigMock.get).toHaveBeenCalledTimes(0)
  })

  test('Doesn\'t work on any command other than deploy/undeploy', async () => {
    hook({
      Command: {
        id: 'absent:command'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(coreConfigMock.get).toHaveBeenCalledTimes(0)
  })

  it('Works on deploy command', async () => {
    coreConfigMock.get.mockResolvedValue(undefined)

    try {
      await hook({
        Command: {
          id: 'app:deploy'
        },
        config: {
          dataDir: '/tmp'
        }
      })
    } catch (e) {} // Expected error due to empty config
    expect(coreConfigMock.get).toHaveBeenCalled()
  })

  it('Works on undeploy command', async () => {
    coreConfigMock.get.mockReturnValue(undefined)

    try {
      await hook({
        Command: {
          id: 'app:undeploy'
        },
        config: {
          dataDir: '/tmp'
        }
      })
    } catch (e) {} // Expected error due to empty config
    expect(coreConfigMock.get).toHaveBeenCalled()
  })

  it('Should add IO management permissions to local creds if absent', async () => {
    serviceProperties.mockResolvedValue([])
    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(consoleCli.subscribeToServices).toHaveBeenCalledWith(
      "testid",
      {
        "id": "123",
        "name": undefined
      },
      {
        "id": "workspace123",
        "name": "Stage"
      },
      "/tmp/entp-int-certs",
      [
        {
          "licenseConfigs": null,
          "name": "I/O Management API",
          "roles": null,
          "sdkCode": "AdobeIOManagementAPISDK"
        }
      ]
    )
  })

  it('Should not add IO management permissions to local creds if present', async () => {
    serviceProperties.mockResolvedValue([{
      sdkCode: 'AdobeIOManagementAPISDK'
    }])
    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(consoleCli.subscribeToServices).toHaveBeenCalledTimes(0)
  })

  it('Should delete all subscriptions during undeploy command ', async () => {
    coreConfigMock.get.mockReset()
    coreConfigMock.get.mockReturnValueOnce({
      id: '123',
      project: undefined,
      projectConfig: {
        id: '123456789',
        name: 'test project'
      },
      org: {
        id: 'testid',
        ims_org_id: 'test@Adobe.org'
      },
      workspace: {
        name: 'Stage',
        id: 'workspace123',
        details: {
          credentials: [{
            integration_type: 'service',
            id: 'test_credentials_id'
          }]
        }
      }
    }).mockReturnValueOnce([
      {
        event_type: 'test',
        registration_id: 'registration123'
      },
      {
        event_type: 'test2',
        registration_id: 'registration456'
      }
    ])

    await hook({
      Command: {
        id: 'app:undeploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })

    expect(deleteWebhookRegistration).toHaveBeenCalledTimes(2)
    expect(deleteWebhookRegistration).toHaveBeenCalledWith('testid', 'test_credentials_id', 'registration123')
    expect(deleteWebhookRegistration).toHaveBeenCalledWith('testid', 'test_credentials_id', 'registration456')
  })

  it('Should ignore actions without declared event types', async () => {
    loadConfig.mockResolvedValue({
      all: {
        application: {
          manifest: {
            full: {
              packages: {
                test_package: {
                  actions: {
                    test_action: {
                      runtime: 'nodejs:14'
                    }
                  }
                }
              }
            }
          }
        }

      }
    })

    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(rtLib.init).toHaveBeenCalledTimes(0)
  })

  it('Should register single webhook', async () => {
    loadConfig.mockResolvedValue({
      all: {
        application: {
          manifest: {
            full: {
              packages: {
                test_package: {
                  actions: {
                    test_action: {
                      runtime: 'nodejs:14',
                      relations: {
                        'event-listener-for': ['test_event_type']
                      }
                    }
                  }
                }
              }
            }
          },
          ow: {
            namespace: 'test_namespace',
            apihost: 'http://testhost.comtest',
            apiversion: 'v1',
            auth: 'test auth'
          }
        }

      }
    })

    prompt.mockResolvedValue({ res: 'test_provider_id' })

    coreConfigMock.get.mockReturnValueOnce([])

    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(getAllProviders).toHaveBeenCalledTimes(1)
    expect(createWebhookRegistration).toHaveBeenCalledTimes(1)
  })

  it('Should choose from multiple providers and register single webhook', async () => {
    loadConfig.mockResolvedValue({
      all: {
        application: {
          manifest: {
            full: {
              packages: {
                test_package: {
                  actions: {
                    test_action: {
                      runtime: 'nodejs:14',
                      relations: {
                        'event-listener-for': ['test_event_type2']
                      }
                    }
                  }
                }
              }
            }
          },
          ow: {
            namespace: 'test_namespace',
            apihost: 'http://testhost.comtest',
            apiversion: 'v1',
            auth: 'test auth'
          }
        }

      }
    })

    prompt.mockResolvedValue({ res: 'test_provider_id3' })

    coreConfigMock.get.mockReturnValueOnce([])

    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })
    expect(getAllProviders).toHaveBeenCalledTimes(1)
    expect(createWebhookRegistration).toHaveBeenCalledTimes(1)
    expect(createWebhookRegistration).toBeCalledWith('testid', 'test_credentials_id',
      expect.objectContaining({
        events_of_interest: expect.arrayContaining([expect.objectContaining({
          provider_id: 'test_provider_id3',
          event_code: 'test_event_type2'
        })])
      })
    )

  })

  it('Should create two registration for two actions in two packages', async () => {
    loadConfig.mockResolvedValue({
      all: {
        application: {
          manifest: {
            full: {
              packages: {
                test_package: {
                  actions: {
                    test_action: {
                      runtime: 'nodejs:14',
                      relations: {
                        'event-listener-for': ['test_event_type']
                      }
                    }
                  }
                },
                test_package2: {
                  actions: {
                    test_action2: {
                      runtime: 'nodejs:14',
                      relations: {
                        'event-listener-for': ['test_event_type2']
                      }
                    }
                  }
                }
              }
            }
          },
          ow: {
            namespace: 'test_namespace',
            apihost: 'http://testhost.comtest',
            apiversion: 'v1',
            auth: 'test auth'
          }
        }

      }
    })

    prompt.mockResolvedValue({ res: 'test_provider_id2' })

    coreConfigMock.get.mockReturnValueOnce([])
    await hook({
      Command: {
        id: 'app:deploy'
      },
      config: {
        dataDir: '/tmp'
      }
    })

    expect(getAllProviders).toHaveBeenCalledTimes(1)
    expect(createWebhookRegistration).toHaveBeenCalledTimes(2)
    expect(createWebhookRegistration).toBeCalledWith('testid', 'test_credentials_id',
      expect.objectContaining({
        events_of_interest: expect.arrayContaining([expect.objectContaining({
          provider_id: 'test_provider_id',
          event_code: 'test_event_type'
        })])
      })
    )
    expect(createWebhookRegistration).toBeCalledWith('testid', 'test_credentials_id',
      expect.objectContaining({
        events_of_interest: expect.arrayContaining([expect.objectContaining({
          provider_id: 'test_provider_id2',
          event_code: 'test_event_type2'
        })])
      })
    )
  })
})