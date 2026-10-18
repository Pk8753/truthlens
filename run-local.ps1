Write-Host "Starting TruthLens Backend and Frontend..." -ForegroundColor Cyan

Start-Process pwsh -ArgumentList "-NoExit", "-Command", "node backend/server.js"
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location frontend; npm run dev"

Write-Host "TruthLens launched!" -ForegroundColor Green
Write-Host "Backend API:  http://localhost:8080"
Write-Host "Frontend App: http://localhost:5173"
