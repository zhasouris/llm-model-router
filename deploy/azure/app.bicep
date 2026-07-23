// ---------------------------------------------------------------------------
// llm-model-router — the Container App itself.
//
// Deployed after infra.bicep and after an image has been pushed to the registry.
// Every provider credential is optional: a key that is not supplied simply is
// not wired in, and models for that vendor stay in the catalog for inspection
// but cannot be forwarded to.
//
// Scope: resource group.
// ---------------------------------------------------------------------------

param location string = resourceGroup().location

@minLength(3)
@maxLength(17)
param namePrefix string = 'llmrouter'

@description('Resource id of the Container Apps managed environment.')
param environmentId string

@description('Resource id of the user-assigned identity that can pull from ACR.')
param identityId string

@description('Registry login server, e.g. myacr.azurecr.io.')
param acrLoginServer string

@description('Fully qualified image reference, e.g. myacr.azurecr.io/llm-model-router:abc1234.')
param image string

@description('Name of the Application Insights component to send telemetry to.')
param appInsightsName string

@description('Comma-separated bearer tokens clients present to the proxy. Leaving this empty does NOT disable auth — it means no token can ever match, so the whole /v1 surface answers 401. That is the correct setting for a demo-only deployment; /v1/router/explain is registered ahead of the auth middleware and still works.')
@secure()
param routerApiKeys string = ''

@secure()
param openaiApiKey string = ''

@secure()
param anthropicApiKey string = ''

@secure()
param classifierApiKey string = ''

@description('Serve the /demo inspector and /v1/router/explain. These are deliberately unauthenticated, and each call spends classifier tokens — leave off unless the demo is the point.')
param demoEnabled bool = false

@description('Show the RouteLLM learned signal alongside the classifier in the inspector. Requires the sidecar (sidecar.bicep) to be deployed.')
param routellmEnabled bool = false

@description('Internal URL of the RouteLLM sidecar, e.g. http://llmrouter-sidecar.')
param routellmUrl string = ''

@description('Scale to zero when idle. Costs nothing at rest; first request after idle pays a cold start.')
param minReplicas int = 0

@description('Upper bound on concurrent replicas — also the ceiling on how fast an abusive caller can spend.')
param maxReplicas int = 3

param tags object = {
  application: 'llm-model-router'
  managedBy: 'bicep'
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Only wire up the secrets that were actually supplied — Container Apps rejects
// a secret with an empty value.
var openaiSecret = empty(openaiApiKey) ? [] : [
  {
    name: 'openai-api-key'
    value: openaiApiKey
  }
]
var anthropicSecret = empty(anthropicApiKey) ? [] : [
  {
    name: 'anthropic-api-key'
    value: anthropicApiKey
  }
]
var classifierSecret = empty(classifierApiKey) ? [] : [
  {
    name: 'classifier-api-key'
    value: classifierApiKey
  }
]

var routerKeysSecret = empty(routerApiKeys) ? [] : [
  {
    name: 'router-api-keys'
    value: routerApiKeys
  }
]

var baseSecrets = [
  {
    name: 'appinsights-connection-string'
    value: appInsights.properties.ConnectionString
  }
]

var secrets = concat(baseSecrets, routerKeysSecret, openaiSecret, anthropicSecret, classifierSecret)

var openaiEnv = empty(openaiApiKey) ? [] : [
  {
    name: 'OPENAI_API_KEY'
    secretRef: 'openai-api-key'
  }
]
var anthropicEnv = empty(anthropicApiKey) ? [] : [
  {
    name: 'ANTHROPIC_API_KEY'
    secretRef: 'anthropic-api-key'
  }
]
var classifierEnv = empty(classifierApiKey) ? [] : [
  {
    name: 'CLASSIFIER_API_KEY'
    secretRef: 'classifier-api-key'
  }
]

var routerKeysEnv = empty(routerApiKeys) ? [] : [
  {
    name: 'ROUTER_API_KEYS'
    secretRef: 'router-api-keys'
  }
]

var baseEnv = [
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    secretRef: 'appinsights-connection-string'
  }
  // Deployment-time overrides of the baked-in config/server.yaml (see config.ts).
  {
    name: 'AZURE_MONITOR_ENABLED'
    value: 'true'
  }
  // Console span export would duplicate every trace into container stdout.
  {
    name: 'OTEL_CONSOLE_EXPORT'
    value: 'false'
  }
  {
    name: 'DEMO_ENABLED'
    value: string(demoEnabled)
  }
  {
    // Show the cold-start banner exactly when the app can scale to zero, since
    // that is the only case where a first request actually waits on a wake-up.
    name: 'DEMO_COLD_START_HINT'
    value: string(minReplicas == 0)
  }
  {
    name: 'ROUTELLM_ENABLED'
    value: string(routellmEnabled)
  }
  {
    name: 'PORT'
    value: '8000'
  }
]

var routellmUrlEnv = empty(routellmUrl) ? [] : [
  {
    name: 'ROUTELLM_URL'
    value: routellmUrl
  }
]

var env = concat(baseEnv, routerKeysEnv, openaiEnv, anthropicEnv, classifierEnv, routellmUrlEnv)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-app'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // Public. There is no gateway or app registration in front of this:
        // /v1/* is protected by the app's own bearer auth (ROUTER_API_KEYS).
        external: true
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'router'
          image: image
          env: env
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8000
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
