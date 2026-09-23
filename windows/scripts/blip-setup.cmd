@echo off
rem Runs blip-setup.ps1 without changing the machine's PowerShell execution policy.
rem   blip-setup.cmd [user@]mac-host
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0blip-setup.ps1" %*
