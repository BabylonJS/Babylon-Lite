param(
    [switch]$Bootstrap,
    [string]$PythonExecutable = "py"
)
$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$cache = Join-Path $root ".ao-reference-cache\kitchen"
$commit = "c823af8961047f4642c985c37338b18a35b6b017"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
foreach ($name in @("Kitchen.usd", "LICENSE")) {
    $path = Join-Path $cache $name
    if (-not (Test-Path -LiteralPath $path)) {
        Invoke-WebRequest "https://raw.githubusercontent.com/DiligentGraphics/USDAssets/$commit/$name" -OutFile $path
    }
}
$usd = [System.IO.File]::ReadAllBytes((Join-Path $cache "Kitchen.usd"))
$blob = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA1)
try {
    $blob.AppendData([System.Text.Encoding]::UTF8.GetBytes("blob $($usd.Length)`0"))
    $blob.AppendData($usd)
    if ([Convert]::ToHexString($blob.GetHashAndReset()).ToLowerInvariant() -ne "f0cddb55f5f7b2c246f32978ddde4d0cf797160a") {
        throw "Kitchen source Git blob mismatch."
    }
} finally { $blob.Dispose() }
if ((Get-FileHash (Join-Path $cache "LICENSE") -Algorithm SHA256).Hash.ToLowerInvariant() -ne "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4") {
    throw "Kitchen source license mismatch."
}
$python = Join-Path $cache "venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    if (-not $Bootstrap) { throw "Missing cache-local Python environment. Run with -Bootstrap and Python 3.13 installed." }
    if ($PythonExecutable -eq "py") { & $PythonExecutable -3.13 -m venv (Join-Path $cache "venv") }
    else { & $PythonExecutable -m venv (Join-Path $cache "venv") }
    if ($LASTEXITCODE -ne 0) { throw "Cannot create the cache-local Python environment." }
}
& $python -c 'from importlib.metadata import version; assert version("usd2gltf") == "0.3.5"; assert version("usd-core") == "26.11"'
if ($LASTEXITCODE -ne 0) {
    if (-not $Bootstrap) { throw "Missing or mismatched converters. Run with -Bootstrap to install the pinned cache-local requirements." }
    & $python -m pip install "usd2gltf==0.3.5" "usd-core==26.11" "numpy==2.5.4" "gltflib==1.0.13"
    if ($LASTEXITCODE -ne 0) { throw "Pinned Kitchen converter installation failed." }
}
$tools = Join-Path $cache "gltf-tools"
& node -e 'const p=require("node:path"),fs=require("node:fs");for(const n of ["core","functions"])if(JSON.parse(fs.readFileSync(p.join(process.argv[1],"node_modules","@gltf-transform",n,"package.json"))).version!=="4.3.0")throw Error("glTF Transform version mismatch")' $tools
if ($LASTEXITCODE -ne 0) {
    if (-not $Bootstrap) { throw "Missing glTF Transform 4.3.0. Run with -Bootstrap for cache-local installation." }
    & npm install --prefix $tools --no-audit --no-fund "@gltf-transform/core@4.3.0" "@gltf-transform/functions@4.3.0"
    if ($LASTEXITCODE -ne 0) { throw "Pinned glTF Transform installation failed." }
}
& (Join-Path $cache "venv\Scripts\usd2gltf.exe") -i (Join-Path $cache "Kitchen.usd") -o (Join-Path $cache "Kitchen.glb")
if ($LASTEXITCODE -ne 0) { throw "Kitchen USD conversion failed." }
Push-Location $root
try {
    & node (Join-Path $PSScriptRoot "optimize-kitchen.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Kitchen optimization/geometry verification failed." }
} finally { Pop-Location }
