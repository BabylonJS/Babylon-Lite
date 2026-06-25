$exeFiles = @(
    ".\dawn\testapp.exe"
)

foreach ($exe in $exeFiles) {
    $exePath = Resolve-Path $exe
    $exeDir  = Split-Path $exePath -Parent
    $exeName = Split-Path $exePath -Leaf

    Write-Host "Running $exeName in $exeDir"

    Push-Location $exeDir
    try {
        & ".\$exeName"
    }
    finally {
        Pop-Location
    }
}