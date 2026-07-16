@echo off
:: Registers run-daily.bat as a Windows Task Scheduler job at 09:00 every day.
:: Run this once as Administrator.
schtasks /Create /TN "GevaExtract\DailyExtract" /TR "C:\Projects\GevaExtract\run-daily.bat" /SC DAILY /ST 09:00 /RU "%USERNAME%" /RL HIGHEST /F
echo.
echo Task registered. To verify:
echo   schtasks /Query /TN "GevaExtract\DailyExtract" /FO LIST
echo.
echo To run immediately:
echo   schtasks /Run /TN "GevaExtract\DailyExtract"
