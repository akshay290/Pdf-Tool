$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
  }
  & '.\.venv\Scripts\python.exe' -m pip install --disable-pip-version-check -r python\requirements.txt
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the local PDF engines.' }
} finally { Pop-Location }
