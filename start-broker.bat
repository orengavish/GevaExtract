@echo off
cd /d C:\Projects\GevaExtract
echo Starting GevaExtract broker...
echo Make sure IB TWS is open in paper trading mode (port 7497).
echo Press Ctrl-C to stop.
echo.
python broker.py
