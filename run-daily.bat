@echo off
cd /d C:\Projects\GevaExtract
node extract.js >> logs\extract.log 2>&1
node to-csv.js  >> logs\extract.log 2>&1
