$ErrorActionPreference = 'Stop'
$kokoCandidates = @(Get-ChildItem -Path "$env:USERPROFILE/.cache/codex-runtimes/*/dependencies/python/python.exe" -ErrorAction SilentlyContinue)
$kokoPythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$kokoPython = if ($kokoCandidates.Count -gt 0) { $kokoCandidates[-1].FullName } elseif ($kokoPythonCommand -and $kokoPythonCommand.Source -notlike '*WindowsApps*') { $kokoPythonCommand.Source } else { $null }
if (-not $kokoPython) { throw '没有找到Python，请先安装Python3.12或启动Codex运行环境。' }
& $kokoPython (Join-Path $PSScriptRoot 'setup.py')
if ($LASTEXITCODE -ne 0) { throw '运行环境安装未完成，请保留报错交给Codex检查。' }
