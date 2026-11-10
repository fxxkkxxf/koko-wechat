$ErrorActionPreference = 'Stop'
$kokoShell = New-Object -ComObject WScript.Shell
$kokoDesktop = [Environment]::GetFolderPath('Desktop')
$kokoShortcutPath = Join-Path $kokoDesktop '可可微信助手.lnk'
if (Test-Path -LiteralPath $kokoShortcutPath) {
    $kokoOld = $kokoShell.CreateShortcut($kokoShortcutPath)
    if ($kokoOld.Arguments -notlike '*koko-wechat*') { throw '已有同名其他快捷方式，请先将它改名。' }
}
$kokoLink = $kokoShell.CreateShortcut($kokoShortcutPath)
$kokoLink.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$kokoLink.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start.ps1') + '"'
$kokoLink.WorkingDirectory = $PSScriptRoot
$kokoLink.IconLocation = (Join-Path $PSScriptRoot 'assets\koko-app.ico') + ',0'
$kokoLink.Description = '可可微信助手：本机桥接、Codex对话和自动回复'
$kokoLink.Save()
Write-Host ('已创建：' + $kokoShortcutPath)
