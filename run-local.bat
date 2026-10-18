@echo off
echo Starting TruthLens Backend and Frontend...

start "TruthLens Backend (Port 8080)" cmd /k "node backend/server.js"
start "TruthLens Frontend (Port 5173)" cmd /k "cd frontend && npm run dev"

echo.
echo TruthLens services launched!
echo - Backend API and Production Bundle: http://localhost:8080
echo - Frontend Development Server:      http://localhost:5173
echo.
