<#
.SYNOPSIS
  Deploy corgi-ai-gateway to Azure Container Apps.

.DESCRIPTION
  Three phases, each independently re-runnable:

    1. infra.bicep   - registry, Log Analytics, App Insights, ACA environment, identity
    2. az acr build  - builds the image *in Azure* from this repo (no local Docker needed)
    3. app.bicep     - the container app, wired to the image and to secrets from .env

  Secrets are read from the .env file at the repo root and passed as secure
  parameters. They are never written to a parameters file and never echoed.

.EXAMPLE
  ./deploy.ps1 -ResourceGroup rg-llm-router -Location eastus

.EXAMPLE
  ./deploy.ps1 -ResourceGroup rg-llm-router -Location eastus -DemoEnabled
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [string]$Location = 'eastus',

    # Seeds the registry and app names.
    [ValidatePattern('^[a-z][a-z0-9]{2,16}$')]
    [string]$NamePrefix = 'llmrouter',

    # Defaults to the .env at the repo root.
    [string]$EnvFile,

    [string]$SubscriptionId,

    # Serve /demo and /v1/router/explain publicly. Off by default: those routes
    # are unauthenticated by design and every call spends classifier tokens.
    [switch]$DemoEnabled,

    # Publish ONLY the decision inspector. Ships the classifier key and nothing
    # else, and deliberately configures no OAuth issuer so the /v1 surface fails
    # closed (401). The demo works because /v1/router/explain is registered ahead
    # of the auth middleware. Nothing can be forwarded to a provider, so the only
    # spend possible is classifier tokens.
    [switch]$DemoOnly,

    [int]$MinReplicas = 0,
    [int]$MaxReplicas = 3,

    # Deploy the RouteLLM sidecar (ADR 0006) and show its learned signal in the
    # inspector. Costs real money: see -SidecarMinReplicas.
    [switch]$WithRouteLLM,

    # 1 keeps the sidecar resident so it always answers. 0 lets it scale to
    # zero - near-free at rest, but it reloads the model from HuggingFace on
    # the next request, so the inspector reports RouteLLM unavailable until it
    # finishes warming up.
    [ValidateRange(0, 1)]
    [int]$SidecarMinReplicas = 1,

    # Skip the image build and redeploy the app against an existing tag.
    [string]$ImageTag
)

$ErrorActionPreference = 'Stop'

# Join-Path takes only two path segments on Windows PowerShell 5.1.
$repoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot '.env' }

function Write-Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Write-Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# --- preflight -------------------------------------------------------------

Write-Step 'Preflight'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "The Azure CLI ('az') is not on PATH. Install from https://aka.ms/installazurecli, then run 'az login'."
}

$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) { throw "Not logged in. Run 'az login' first." }

if ($SubscriptionId) {
    az account set --subscription $SubscriptionId
    $account = az account show | ConvertFrom-Json
}
Write-Note "Subscription: $($account.name) [$($account.id)]"

# The containerapp commands live in an extension; install up front so the
# deployment does not stop halfway to prompt.
az extension add --name containerapp --upgrade --only-show-errors 2>$null | Out-Null
foreach ($ns in @(
        'Microsoft.App',
        'Microsoft.OperationalInsights',
        'Microsoft.Insights',
        'Microsoft.ContainerRegistry',
        'Microsoft.ManagedIdentity'
    )) {
    az provider register --namespace $ns --only-show-errors 2>$null | Out-Null
}

# --- secrets from .env -----------------------------------------------------

Write-Step 'Reading secrets'

if (-not (Test-Path $EnvFile)) {
    throw "Env file not found: $EnvFile. Copy .env.example to .env and fill in the provider keys."
}

$envMap = @{}
foreach ($line in Get-Content $EnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $envMap[$trimmed.Substring(0, $idx).Trim()] = $trimmed.Substring($idx + 1).Trim()
}

function Get-EnvValue($name) {
    if ($envMap.ContainsKey($name)) { return $envMap[$name] }
    return ''
}

# OAuth issuer/audience/scope protect /v1 (ADR 0015). Not secrets — read from
# .env for convenience. No issuer => the gateway fails closed (every /v1 -> 401).
$authIssuer = Get-EnvValue 'AUTH_ISSUER'
$authAudience = Get-EnvValue 'AUTH_AUDIENCE'
$authScope = Get-EnvValue 'AUTH_REQUIRED_SCOPE'

if ($DemoOnly) {
    # Inspector-only: ship the classifier key and nothing else, and configure no
    # OAuth issuer so /v1 fails closed.
    $DemoEnabled = [switch]$true

    $classifierKey = Get-EnvValue 'CLASSIFIER_API_KEY'
    if (-not $classifierKey) { $classifierKey = Get-EnvValue 'OPENAI_API_KEY' }
    if (-not $classifierKey) {
        throw "Demo-only needs a classifier key: set CLASSIFIER_API_KEY (or OPENAI_API_KEY) in $EnvFile."
    }

    $authIssuer = ''
    $authAudience = ''
    $authScope = ''
    $openaiKey = ''
    $anthropicKey = ''

    Write-Note 'Mode: DEMO ONLY'
    Write-Note '  classifier key  shipped (the inspector needs it for real signals)'
    Write-Note '  provider keys   NOT shipped - nothing can be forwarded upstream'
    Write-Note '  no OAuth issuer - the whole /v1 surface fails closed (401)'
}
else {
    if (-not $authIssuer) {
        throw @"
AUTH_ISSUER is empty in $EnvFile.

This deployment is publicly reachable with no layer in front of it, and OAuth
JWT validation is the only thing protecting /v1/chat/completions. Set
AUTH_ISSUER (and usually AUTH_AUDIENCE) to your OIDC provider and re-run - or
pass -DemoOnly to publish just the decision inspector, which needs no issuer.
"@
    }
    $openaiKey = Get-EnvValue 'OPENAI_API_KEY'
    $anthropicKey = Get-EnvValue 'ANTHROPIC_API_KEY'
    $classifierKey = Get-EnvValue 'CLASSIFIER_API_KEY'

    Write-Note "OAuth issuer  : $authIssuer"
    Write-Note "OAuth audience: $(if ($authAudience) { $authAudience } else { '(none - aud not checked)' })"
    Write-Note "Required scope: $(if ($authScope) { $authScope } else { '(none)' })"
    foreach ($k in @('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLASSIFIER_API_KEY')) {
        $state = if (Get-EnvValue $k) { 'set' } else { 'absent' }
        Write-Note ("  {0,-22} {1}" -f $k, $state)
    }
}

# --- 1. infrastructure -----------------------------------------------------

Write-Step "Resource group '$ResourceGroup' in $Location"
az group create --name $ResourceGroup --location $Location --only-show-errors --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not create the resource group.' }

Write-Step 'Deploying infrastructure (infra.bicep)'
$infraJson = az deployment group create `
    --resource-group $ResourceGroup `
    --name "$NamePrefix-infra" `
    --template-file (Join-Path $PSScriptRoot 'infra.bicep') `
    --parameters "location=$Location" "namePrefix=$NamePrefix" `
    --query properties.outputs `
    --output json
if ($LASTEXITCODE -ne 0) { throw 'Infrastructure deployment failed.' }

$infra = $infraJson | ConvertFrom-Json
$acrName = $infra.acrName.value
$acrLoginServer = $infra.acrLoginServer.value
Write-Note "Registry:    $acrLoginServer"
Write-Note "Environment: $($infra.environmentId.value.Split('/')[-1])"

# --- 2. image --------------------------------------------------------------

if (-not $ImageTag) {
    $ImageTag = (& git -C $repoRoot rev-parse --short HEAD).Trim()
    if (-not $ImageTag) { $ImageTag = 'latest' }

    Write-Step "Building image in ACR (tag: $ImageTag)"
    Write-Note 'Built by Azure from this source tree - no local Docker required.'
    az acr build `
        --registry $acrName `
        --image "corgi-ai-gateway:$ImageTag" `
        --file (Join-Path $repoRoot 'Dockerfile') `
        --only-show-errors `
        $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
}
else {
    Write-Step "Skipping build, using existing tag: $ImageTag"
}

$image = "$acrLoginServer/corgi-ai-gateway:$ImageTag"

# --- 2b. the RouteLLM sidecar ----------------------------------------------

$routellmUrl = ''
if ($WithRouteLLM) {
    # The mf router embeds prompts through OpenAI, so the sidecar needs a key of
    # its own even in demo-only mode - where the router container deliberately
    # has none. The key lives only in the sidecar, which has internal ingress,
    # so it still cannot be used to run a completion from outside.
    $sidecarOpenaiKey = Get-EnvValue 'OPENAI_API_KEY'
    if (-not $sidecarOpenaiKey) { $sidecarOpenaiKey = Get-EnvValue 'CLASSIFIER_API_KEY' }
    if (-not $sidecarOpenaiKey) {
        throw "The RouteLLM sidecar needs OPENAI_API_KEY (or CLASSIFIER_API_KEY) in $EnvFile for prompt embeddings."
    }

    Write-Step "Building sidecar image in ACR (tag: $ImageTag)"
    Write-Note 'Large image - it pulls PyTorch. First build takes several minutes.'
    az acr build `
        --registry $acrName `
        --image "routellm-sidecar:$ImageTag" `
        --file (Join-Path $repoRoot 'sidecar/Dockerfile') `
        --only-show-errors `
        (Join-Path $repoRoot 'sidecar')
    if ($LASTEXITCODE -ne 0) { throw 'Sidecar image build failed.' }

    Write-Step 'Deploying RouteLLM sidecar (sidecar.bicep)'
    $sidecarJson = az deployment group create `
        --resource-group $ResourceGroup `
        --name "$NamePrefix-sidecar" `
        --template-file (Join-Path $PSScriptRoot 'sidecar.bicep') `
        --parameters `
            "location=$Location" `
            "namePrefix=$NamePrefix" `
            "environmentId=$($infra.environmentId.value)" `
            "identityId=$($infra.identityId.value)" `
            "acrLoginServer=$acrLoginServer" `
            "image=$acrLoginServer/routellm-sidecar:$ImageTag" `
            "openaiApiKey=$sidecarOpenaiKey" `
            "minReplicas=$SidecarMinReplicas" `
        --query properties.outputs `
        --output json
    if ($LASTEXITCODE -ne 0) { throw 'Sidecar deployment failed.' }

    $routellmUrl = ($sidecarJson | ConvertFrom-Json).internalUrl.value
    Write-Note "Sidecar reachable in-environment at $routellmUrl"
    Write-Note 'It downloads model weights on first start; RouteLLM shows as unavailable until that finishes.'
}

# --- 3. the app ------------------------------------------------------------

Write-Step 'Deploying container app (app.bicep)'

# Built as an array so a value containing spaces or punctuation cannot be
# re-split by the shell on its way to az.
$appParams = @(
    "location=$Location"
    "namePrefix=$NamePrefix"
    "environmentId=$($infra.environmentId.value)"
    "identityId=$($infra.identityId.value)"
    "acrLoginServer=$acrLoginServer"
    "appInsightsName=$($infra.appInsightsName.value)"
    "image=$image"
    "authIssuer=$authIssuer"
    "authAudience=$authAudience"
    "authRequiredScope=$authScope"
    "openaiApiKey=$openaiKey"
    "anthropicApiKey=$anthropicKey"
    "classifierApiKey=$classifierKey"
    "demoEnabled=$($DemoEnabled.IsPresent.ToString().ToLower())"
    "routellmEnabled=$($WithRouteLLM.IsPresent.ToString().ToLower())"
    "routellmUrl=$routellmUrl"
    "minReplicas=$MinReplicas"
    "maxReplicas=$MaxReplicas"
)

# The AcrPull role assignment is created by infra.bicep, and RBAC takes a
# little while to propagate. On a first deployment the app can therefore fail
# its very first image pull with an authorization error even though everything
# is configured correctly, so retry once before treating it as a real failure.
$appJson = $null
foreach ($attempt in 1..2) {
    $appJson = az deployment group create `
        --resource-group $ResourceGroup `
        --name "$NamePrefix-app" `
        --template-file (Join-Path $PSScriptRoot 'app.bicep') `
        --parameters $appParams `
        --query properties.outputs `
        --output json
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 1) {
        Write-Note 'Deployment failed; waiting 45s for the AcrPull role to propagate, then retrying once...'
        Start-Sleep -Seconds 45
    }
}
if ($LASTEXITCODE -ne 0) { throw 'App deployment failed.' }

$appOut = $appJson | ConvertFrom-Json
$url = $appOut.url.value

# --- smoke test ------------------------------------------------------------

Write-Step 'Smoke test'

$healthy = $false
foreach ($attempt in 1..10) {
    try {
        $health = Invoke-WebRequest -Uri "$url/healthz" -TimeoutSec 20 -UseBasicParsing
        if ($health.StatusCode -eq 200) { $healthy = $true; break }
    }
    catch {
        Write-Note "waiting for the first revision to come up ($attempt/10)..."
        Start-Sleep -Seconds 10
    }
}

if ($healthy) {
    Write-Host '    /healthz   200 OK' -ForegroundColor Green
}
else {
    Write-Warning "/healthz did not answer. Check: az containerapp logs show -n $NamePrefix-app -g $ResourceGroup --follow"
}

# /v1/* must reject an unauthenticated call - it is the only thing standing
# between the public internet and your provider credits.
try {
    Invoke-WebRequest -Uri "$url/v1/models" -TimeoutSec 20 -UseBasicParsing | Out-Null
    Write-Warning '/v1/models answered WITHOUT a key - proxy auth is NOT protecting the API surface.'
}
catch {
    $code = $null
    if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
    if ($code -eq 401) {
        Write-Host '    /v1/models 401 without a key (auth is enforced)' -ForegroundColor Green
    }
    else {
        Write-Note "/v1/models returned $code"
    }
}

if ($DemoEnabled) {
    # The inspector has to actually work, and it has to work unauthenticated -
    # it sits ahead of the auth middleware on purpose.
    try {
        $explain = Invoke-WebRequest -Uri "$url/v1/router/explain" -Method Post `
            -ContentType 'application/json' `
            -Body '{"messages":[{"role":"user","content":"Say hi"}]}' `
            -TimeoutSec 40 -UseBasicParsing
        if ($explain.StatusCode -eq 200) {
            $decision = ($explain.Content | ConvertFrom-Json).decision
            Write-Host "    /v1/router/explain 200 -> $($decision.model)" -ForegroundColor Green
            Write-Host "    X-Router-Duration-Ms $($explain.Headers['X-Router-Duration-Ms'])" -ForegroundColor Green
        }
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
        Write-Warning "/v1/router/explain returned $code - the inspector is not working."
    }
}

if ($DemoOnly) {
    # Forwarding must be impossible: no provider keys were shipped, and with no
    # router token the endpoint is unreachable in the first place.
    try {
        Invoke-WebRequest -Uri "$url/v1/chat/completions" -Method Post `
            -ContentType 'application/json' `
            -Body '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' `
            -TimeoutSec 20 -UseBasicParsing | Out-Null
        Write-Warning 'DEMO-ONLY BREACH: /v1/chat/completions answered without a key.'
    }
    catch {
        $code = $null
        if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
        if ($code -eq 401) {
            Write-Host '    /v1/chat/completions 401 (closed, as intended)' -ForegroundColor Green
        }
        else {
            Write-Warning "/v1/chat/completions returned $code - expected 401."
        }
    }
}

Write-Step 'Done'
Write-Host "  URL:     $url"
Write-Host "  Swagger: $url/docs"
if ($DemoEnabled) {
    Write-Host "  Demo:    $url/demo   (public, unauthenticated, spends classifier tokens)" -ForegroundColor Yellow
}
if ($DemoOnly) {
    Write-Host ''
    Write-Host '  Demo-only: the inspector is the whole surface. No provider keys were' -ForegroundColor DarkGray
    Write-Host '  deployed, so nothing can be forwarded upstream and the only cost this' -ForegroundColor DarkGray
    Write-Host '  deployment can incur is classifier tokens, one cheap call per inspect.' -ForegroundColor DarkGray
}
Write-Host "  Logs:    az containerapp logs show -n $NamePrefix-app -g $ResourceGroup --follow"
Write-Host "  Remove:  ./teardown.ps1 -ResourceGroup $ResourceGroup"
