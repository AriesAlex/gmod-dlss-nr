#Requires -Version 5.1
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reshadeRoot = Join-Path $projectRoot 'sources\reshade'
$bridgeRoot = Join-Path $projectRoot 'sources\bridge'
$payloadPrefix = 'payload/bridge/bin/win64'
$payloadDirectory = Join-Path $projectRoot $payloadPrefix

foreach ($command in @('git', 'python', 'pip')) {
    $null = Get-Command $command -ErrorAction Stop
}
foreach ($source in @('reshade', 'bridge')) {
    $sourceRoot = Join-Path $projectRoot "sources\$source"
    $patchPath = Join-Path $projectRoot "patches\$source.patch"
    if (!(Test-Path -LiteralPath $sourceRoot -PathType Container) -or
        !(Test-Path -LiteralPath $patchPath -PathType Leaf)) {
        throw "Missing sources or patch for $source. Run 'bun run sources:prepare' first."
    }
    & git -C $sourceRoot apply --reverse --check $patchPath
    if ($LASTEXITCODE -ne 0) {
        throw "The $source patch is not applied cleanly. Run 'bun run sources:prepare'; preserve local edits if it reports a conflict."
    }
    $submodules = @(& git -C $sourceRoot submodule status --recursive)
    if ($LASTEXITCODE -ne 0 -or ($submodules | Where-Object { $_ -match '^[-+U]' })) {
        throw "$source submodules are not at their pinned revisions. Run 'bun run sources:prepare' first."
    }
}
foreach ($file in @((Join-Path $reshadeRoot 'ReShade.sln'), (Join-Path $bridgeRoot 'src\build.cmd'))) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Missing $file. Run 'bun run sources:prepare' first."
    }
}

$vswhere = Get-Command vswhere.exe -ErrorAction SilentlyContinue
if ($vswhere) {
    $vswherePath = $vswhere.Source
}
else {
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
}
if (!(Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
    throw 'vswhere.exe is missing. Install Visual Studio or Build Tools with the Desktop development with C++ workload.'
}
$vsPath = & $vswherePath -latest -products '*' -requires Microsoft.Component.MSBuild `
    Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -prerelease
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vsPath)) {
    throw 'No Visual Studio installation with MSBuild and the x64 C++ toolchain was found.'
}
$msbuild = Join-Path $vsPath 'MSBuild\Current\Bin\MSBuild.exe'
$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
foreach ($file in @($msbuild, $vcvars)) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build tool: $file" }
}

$compilerEnvironment = & $env:ComSpec /d /c "call `"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the Visual C++ x64 environment.' }
foreach ($entry in $compilerEnvironment) {
    if ($entry -match '^([^=]+)=(.*)$') {
        Set-Item -LiteralPath "Env:$($Matches[1])" -Value $Matches[2]
    }
}
$null = Get-Command cl.exe, rc.exe -ErrorAction Stop
if ($CheckOnly) {
    Write-Host "Legacy preflight passed: $vsPath; ReShade Release|64-bit and bridge x64"
    Write-Host "Build output will update only $payloadDirectory"
    return
}

$previousVcvars = $env:VCVARS
Push-Location $reshadeRoot
try {
    # ReShade's solution target includes its native dependency projects, but not the setup UI.
    & $msbuild (Join-Path $reshadeRoot 'ReShade.sln') /t:ReShade /p:Configuration=Release /p:Platform=64-bit /m:2 /nologo /v:minimal
    if ($LASTEXITCODE -ne 0) { throw 'ReShade Release x64 compilation failed.' }

    $env:VCVARS = $vcvars
    & (Join-Path $bridgeRoot 'src\build.cmd')
    if ($LASTEXITCODE -ne 0) { throw 'DLSS bridge x64 compilation failed.' }

    $outputs = @(
        (Join-Path $reshadeRoot 'bin\x64\Release\ReShade64.dll'),
        (Join-Path $bridgeRoot 'src\dlss5-bridge.addon64')
    )
    foreach ($output in $outputs) {
        if (!(Test-Path -LiteralPath $output -PathType Leaf)) {
            throw "Build did not produce $output"
        }
    }
    $null = New-Item -ItemType Directory -Path $payloadDirectory -Force
    foreach ($output in $outputs) {
        Copy-Item -LiteralPath $output -Destination $payloadDirectory -Force
    }

    $manifestPath = Join-Path $projectRoot 'config\payload-files.json'
    $payloadManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($output in $outputs) {
        $file = "$payloadPrefix/$([IO.Path]::GetFileName($output))"
        $entries = @($payloadManifest.files | Where-Object { $_.file -ceq $file })
        if ($entries.Count -ne 1) { throw "Expected one payload manifest entry for $file" }
        $destination = Join-Path $projectRoot $file
        $entries[0].sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        $entries[0].sizeBytes = (Get-Item -LiteralPath $destination).Length
    }
    $manifestJson = $payloadManifest | ConvertTo-Json -Depth 100
    [IO.File]::WriteAllText($manifestPath, "$manifestJson`n", [Text.UTF8Encoding]::new($false))
    Write-Host "Updated legacy bridge payload: $payloadDirectory"
}
finally {
    Pop-Location
    if ($null -eq $previousVcvars) {
        Remove-Item Env:VCVARS -ErrorAction SilentlyContinue
    }
    else {
        $env:VCVARS = $previousVcvars
    }
}
