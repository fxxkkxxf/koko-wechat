$ErrorActionPreference = 'Stop'
$kokoRoot = $PSScriptRoot
try {
    $kokoNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $kokoNode = if ($kokoNodeCommand) { $kokoNodeCommand.Source } else { $null }
    if (-not $kokoNode) {
        $kokoCandidates = @(Get-ChildItem -Path "$env:USERPROFILE/.cache/codex-runtimes/*/dependencies/node/bin/node.exe" -ErrorAction SilentlyContinue)
        if ($kokoCandidates.Count -gt 0) { $kokoNode = $kokoCandidates[-1].FullName }
    }
    if (-not $kokoNode) { throw '没有找到Node运行环境，请先安装并启动Codex。' }
    & $kokoNode (Join-Path $kokoRoot 'server.mjs') --ensure --open | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '可可微信版启动失败，请查看本机service.log。' }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '可可微信助手', 'OK', 'Error') | Out-Null
    exit 1
}
