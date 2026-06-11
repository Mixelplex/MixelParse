# pack-session.ps1
# Run from MixelParse-Source\MixelParse\ before each Claude session
# Produces session-upload.zip ready to upload

$files = @(
    "src\index.html",
    "src\admin.html",
    "src\setup.html",
    "electron\main.js",
    "electron\preload.js",
    "electron\ipc\watcher.js",
    "watcher\mixelparse-watcher.js"
)

# Find latest handoff doc in repo root
$handoff = Get-ChildItem -Path "." -Filter "HANDOFF_v*.md" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1

if ($handoff) {
    Write-Host "Found handoff: $($handoff.Name)"
    $allFiles = $files + $handoff.FullName
} else {
    Write-Host "No handoff doc found — zipping source files only"
    $allFiles = $files
}

# Remove old zip if exists
if (Test-Path "session-upload.zip") {
    Remove-Item "session-upload.zip" -Force
}

Compress-Archive -Path $allFiles -DestinationPath "session-upload.zip"
Write-Host "Done — session-upload.zip ready to upload"
