Write-Host "Installing @dmsdc-ai/aigentry-telepty..." -ForegroundColor Cyan

# 1. Check for Node.js/npm and install if missing
if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Warning: Node.js/npm not found. Attempting to install via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
        Write-Host "Refreshing environment variables..." -ForegroundColor Cyan
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Host "Error: winget not found. Please install Node.js manually: https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
}

# 2. Install telepty via npm
Write-Host "Installing telepty globally..." -ForegroundColor Cyan
npm install -g @dmsdc-ai/aigentry-telepty

# 3. Setup Daemon
Write-Host "Setting up Windows background process..." -ForegroundColor Cyan
$teleptyCmd = Get-Command telepty -ErrorAction SilentlyContinue
if (!$teleptyCmd) {
    Write-Host "Error: Failed to locate telepty executable after installation." -ForegroundColor Red
    exit 1
}

$teleptyPath = $teleptyCmd.Source
try {
    & $teleptyPath cleanup-daemons | Out-Null
} catch {
    Write-Host "Warning: Could not clean up existing telepty daemons." -ForegroundColor Yellow
}

Start-Process -FilePath $teleptyPath -ArgumentList "daemon" -WindowStyle Hidden
Write-Host "Success: Windows daemon started in background." -ForegroundColor Green

Write-Host "`nInstallation complete! Telepty daemon is running." -ForegroundColor Cyan
Write-Host "Next step: Try running: telepty attach" -ForegroundColor Yellow
Write-Host "Optional: Run telepty and choose 'Install telepty skills' to add skills for Claude Code, Codex, or Gemini" -ForegroundColor Yellow
