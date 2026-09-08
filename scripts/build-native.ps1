#Requires -Version 5.1
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $projectRoot 'sources\remix'
$patchPath = Join-Path $projectRoot 'patches\remix.patch'
$buildDirectory = '_Comp64DebugOptimized'
$payloadPrefix = 'payload/native/bin/win64'
$payloadDirectory = Join-Path $projectRoot $payloadPrefix

foreach ($command in @('git', 'meson', 'ninja', 'python')) {
    $null = Get-Command $command -ErrorAction Stop
}
foreach ($file in @('build_common.ps1', 'meson.build', 'packman-external.xml', 'src\dlssnr_shim\remix_nvngx.cpp')) {
    if (!(Test-Path -LiteralPath (Join-Path $sourceRoot $file) -PathType Leaf)) {
        throw "Missing sources/remix/$file. Run 'bun run sources:prepare' first."
    }
}
if (!(Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw "Missing $patchPath. Restore the project's patches before building."
}
& git -C $sourceRoot apply --reverse --check $patchPath
if ($LASTEXITCODE -ne 0) {
    throw "The native source patch is not applied cleanly. Run 'bun run sources:prepare'; preserve local edits if it reports a conflict."
}
$submodules = @(& git -C $sourceRoot submodule status --recursive)
if ($LASTEXITCODE -ne 0 -or ($submodules | Where-Object { $_ -match '^[-+U]' })) {
    throw "Remix submodules are not at their pinned revisions. Run 'bun run sources:prepare' first."
}

Push-Location $sourceRoot
try {
    . .\build_common.ps1
    # SetupBuild otherwise accepts any existing LIBPATH and skips the requested toolset.
    Remove-Item Env:LIBPATH -ErrorAction SilentlyContinue
    SetupBuild -BuildArch x64 -VcVarsVer 14.41
    if ($env:VCToolsVersion -notlike '14.41.*' -or $env:VSCMD_ARG_TGT_ARCH -ne 'x64') {
        throw 'Native build requires MSVC 14.41 for x64. Install that toolset in Visual Studio Installer.'
    }
    $null = Get-Command cl.exe, rc.exe -ErrorAction Stop

    if ($CheckOnly) {
        Write-Host "Native preflight passed: MSVC $env:VCToolsVersion x64; source $sourceRoot"
        Write-Host "Build output will update only $payloadDirectory"
        return
    }

    # Configure and compile in this shell so Meson keeps the pinned MSVC environment.
    # Packman downloads the public SDK dependencies during setup; APIC test data is unused.
    # Patched fs.is_file guards allow nv-private and dxvk_rt_testing to be absent.
    $setupArguments = @('setup', '--buildtype', 'debugoptimized', '--backend', 'ninja',
        '-Denable_tracy=false', '-Denable_tests=false', '-Ddownload_apics=false')
    if (Test-Path -LiteralPath "$buildDirectory\meson-private\coredata.dat" -PathType Leaf) {
        $setupArguments += '--reconfigure'
    }
    $setupArguments += $buildDirectory
    & meson @setupArguments
    if ($LASTEXITCODE -ne 0) { throw 'Native Meson configuration failed.' }

    & meson compile -C $buildDirectory -j 2 rtx_shaders
    if ($LASTEXITCODE -ne 0) { throw 'Native shader compilation failed.' }
    & meson compile -C $buildDirectory -j 2 d3d9 remix_nvngx
    if ($LASTEXITCODE -ne 0) { throw 'Native DLL compilation failed.' }

    $outputs = @(
        (Join-Path $sourceRoot "$buildDirectory\src\d3d9\d3d9.dll"),
        (Join-Path $sourceRoot "$buildDirectory\src\dlssnr_shim\remix_nvngx.dll")
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
    Write-Host "Updated native payload: $payloadDirectory"
}
finally {
    Pop-Location
}
