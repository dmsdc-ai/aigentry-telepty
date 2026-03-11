Write-Host "🚀 Installing @dmsdc-ai/aigentry-telepty..." -ForegroundColor Cyan

# 1. Check for Node.js/npm and install if missing
if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️ Node.js/npm not found. Attempting to install via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
        Write-Host "🔄 Refreshing environment variables..." -ForegroundColor Cyan
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        Write-Host "❌ winget not found. Please install Node.js manually: https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
}

# 2. Install telepty via npm
Write-Host "📦 Installing telepty globally..." -ForegroundColor Cyan
npm install -g @dmsdc-ai/aigentry-telepty

# 3. Setup Daemon
Write-Host "⚙️ Setting up Windows background process..." -ForegroundColor Cyan
$teleptyCmd = Get-Command telepty -ErrorAction SilentlyContinue
if (!$teleptyCmd) {
    Write-Host "❌ Failed to locate telepty executable after installation." -ForegroundColor Red
    exit 1
}

$teleptyPath = $teleptyCmd.Source
Start-Process -NoNewWindow -FilePath node -ArgumentList "$teleptyPath daemon" -WindowStyle Hidden
Write-Host "✅ Windows daemon started in background." -ForegroundColor Green

Write-Host "`n🎉 Installation complete! Telepty daemon is running." -ForegroundColor Cyan
Write-Host "👉 Try running: telepty attach" -ForegroundColor Yellow
