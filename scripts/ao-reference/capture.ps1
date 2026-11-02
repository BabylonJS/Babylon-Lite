param(
    [Parameter(Mandatory = $true)][string]$ShaderDirectory,
    [Parameter(Mandatory = $true)][string]$TasksFile
)
$ErrorActionPreference = "Stop"
Add-Type -Path (Join-Path $PSScriptRoot "native.cs")
[AoReference.NativeRunner]::Run($ShaderDirectory, $TasksFile)
