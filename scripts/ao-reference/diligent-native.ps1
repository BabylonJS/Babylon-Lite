param(
    [Parameter(Mandatory = $true)][string]$ShaderDirectory,
    [Parameter(Mandatory = $true)][string]$TasksFile,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = "Stop"
$original = Join-Path $PSScriptRoot "native.cs"
$manifestPath = Join-Path $PSScriptRoot "..\..\reference\lite\ao-reference\manifest.json"
$expected = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).generator.'native.cs'
$source = [System.IO.File]::ReadAllText($original)
$canonical = $source.Replace("`r`n", "`n").Replace("`n", "`r`n")
$canonicalHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    # Git may normalize the original Windows file to LF; its canonical content must still match.
    if ($canonicalHash -ne $expected) {
        throw "The immutable spatial reference host changed."
    }
}
$replacements = @(
    @("public static class NativeRunner {", "public static partial class NativeRunner {"),
    @("private sealed class DirectX : IDisposable {", "private sealed partial class DirectX : IDisposable {"),
    @("byte[] input = null) {", "byte[] input = null, uint extraBind = 0) {"),
    @("Bind = 8u | (writable ? 128u : 0u) };", "Bind = 8u | (writable ? 128u : 0u) | extraBind };")
)
foreach ($pair in $replacements) {
    if ([regex]::Matches($source, [regex]::Escape($pair[0])).Count -ne 1) {
        throw "The reference host adaptation did not match exactly once: $($pair[0])"
    }
    $source = $source.Replace($pair[0], $pair[1])
}
$generated = Join-Path $ShaderDirectory "diligent-host-base.cs"
[System.IO.File]::WriteAllText($generated, $source, [System.Text.UTF8Encoding]::new($false))
Add-Type -Path @($generated, (Join-Path $PSScriptRoot "diligent-native.cs"))
[AoReference.NativeRunner]::RunDiligent($ShaderDirectory, $TasksFile, $OutputDirectory)
