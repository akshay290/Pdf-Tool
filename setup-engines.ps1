param([string]$PythonCommand = 'python', [switch]$IncludeLibreOffice)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $PythonCommand -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
  }
  & '.\.venv\Scripts\python.exe' -m pip install --disable-pip-version-check -r python\requirements-lock.txt
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned Python engines.' }
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned Node engines.' }
  $modelRoot = Join-Path $PSScriptRoot 'runtime\tessdata'
  New-Item -ItemType Directory -Path $modelRoot -Force | Out-Null
  $models = Get-Content -LiteralPath 'python\ocr-models.json' -Raw | ConvertFrom-Json
  $modelRevision = '87416418657359cb625c412a48b6e1d6d41c29bd'
  foreach ($model in $models) {
    $target = Join-Path $modelRoot ($model.language + '.traineddata')
    if (-not (Test-Path -LiteralPath $target)) {
      Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/' + $modelRevision + '/' + $model.language + '.traineddata') -OutFile $target
    }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $model.Hash) {
      throw ('OCR model checksum differs from this release: ' + $model.language + '. Obtain the matching release model before continuing.')
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $modelRoot 'LICENSE'))) {
    Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/' + $modelRevision + '/LICENSE') -OutFile (Join-Path $modelRoot 'LICENSE')
  }
  if ($IncludeLibreOffice -and -not (Test-Path -LiteralPath 'runtime\libreoffice\program\soffice.com')) {
    $installRoot = Join-Path $PSScriptRoot 'runtime\libreoffice'
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    $installer = Join-Path $PSScriptRoot 'runtime\LibreOffice_26.8.1_Win_x86-64.msi'
    if (-not (Test-Path -LiteralPath $installer)) {
      try {
        Invoke-WebRequest -Uri 'https://download.documentfoundation.org/libreoffice/stable/26.8.1/win/x86_64/LibreOffice_26.8.1_Win_x86-64.msi' -OutFile $installer
      } catch { throw 'The pinned LibreOffice installer could not be downloaded. Use a local LibreOffice installation and set LOCALFOLD_LIBREOFFICE to its soffice executable.' }
    }
    $expected = 'C6298B10CFA1748BCBEDAD94C62CE771E240E5021BFD6D7A967CD571B04B5312'
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expected) { throw 'LibreOffice installer checksum did not match the pinned official release.' }
    $arguments = '/a "' + $installer + '" /qn TARGETDIR="' + $installRoot + '"'
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw ('LibreOffice runtime extraction failed: ' + $process.ExitCode) }
  }
  Write-Host 'Local engines are ready. Run npm test, then npm start.'
} finally { Pop-Location }
