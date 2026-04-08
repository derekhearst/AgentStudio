param(
    [string]$RemoteUrl = "https://agentstudio.derekhearst.com",
    [string]$Target = "aarch64",
    [switch]$Release
)

$ErrorActionPreference = "Stop"

$sdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$ndkRoot = Join-Path $sdkRoot "ndk\27.0.12077973"
$vcVars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if (-not (Test-Path $sdkRoot)) {
    throw "Android SDK not found at $sdkRoot"
}

if (-not (Test-Path $ndkRoot)) {
    throw "Android NDK not found at $ndkRoot"
}

if (-not (Test-Path $vcVars)) {
    throw "Visual Studio vcvars64.bat not found at $vcVars"
}

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:NDK_HOME = $ndkRoot
$env:TAURI_REMOTE_URL = $RemoteUrl

$modeArg = if ($Release) { "" } else { "--debug" }
$command = "call `"$vcVars`" && bunx tauri android build $modeArg --apk --target $Target"

Write-Host "Building Android APK..."
Write-Host "TAURI_REMOTE_URL=$RemoteUrl"
& cmd.exe /c $command
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$apkRoot = Join-Path $PSScriptRoot "..\src-tauri\gen\android\app\build\outputs\apk"
if (Test-Path $apkRoot) {
    $latestApk = Get-ChildItem -Path $apkRoot -Recurse -Filter *.apk |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -ne $latestApk) {
        Write-Host "APK built at: $($latestApk.FullName)"
    }
}
