param(
    [string]$ApkPath = "",
    [string]$PackageId = "com.agentstudio.app",
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Resolve-AdbPath {
    $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
    if (Test-Path $sdkAdb) {
        return $sdkAdb
    }

    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCommand) {
        return $adbCommand.Source
    }

    throw "adb not found. Install Android platform-tools or add adb to PATH."
}

function Resolve-ApkPath([string]$Candidate) {
    if ($Candidate -and (Test-Path $Candidate)) {
        return (Resolve-Path $Candidate).Path
    }

    $apkRoot = Join-Path $PSScriptRoot "..\src-tauri\gen\android\app\build\outputs\apk"
    if (-not (Test-Path $apkRoot)) {
        throw "No APK output directory found at $apkRoot. Run the build script first."
    }

    $latestApk = Get-ChildItem -Path $apkRoot -Recurse -Filter *.apk |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($null -eq $latestApk) {
        throw "No APK files found in $apkRoot. Run the build script first."
    }

    return $latestApk.FullName
}

$adb = Resolve-AdbPath
$resolvedApkPath = Resolve-ApkPath $ApkPath

Write-Host "Installing APK: $resolvedApkPath"
& $adb install -r $resolvedApkPath
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if (-not $NoLaunch) {
    Write-Host "Launching $PackageId..."
    & $adb shell monkey -p $PackageId -c android.intent.category.LAUNCHER 1
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Write-Host "Install complete."
