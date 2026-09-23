# Build only: no downloads, toolchain installation, catalog generation or staging.
param(
  [Parameter(Mandatory=$true)][string]$LlamaSource,
  [Parameter(Mandatory=$true)][string]$BuildRoot,
  [Parameter(Mandatory=$true)][string]$CMake
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitProcess){throw 'Use Windows x64 PowerShell'}
$commit='391fac16460f15233a7740550d858ac96df3419d'
if((& git -C $LlamaSource rev-parse HEAD) -ne $commit){throw 'llama.cpp source commit differs'}
if((& git -C $LlamaSource status --porcelain)){throw 'llama.cpp source must be unchanged'}
if(Test-Path $BuildRoot){throw 'Use a new isolated build directory'}
New-Item -ItemType Directory $BuildRoot | Out-Null
& $CMake -S $LlamaSource -B "$BuildRoot/cuda" -G 'Visual Studio 17 2022' -A x64 -T 'cuda=13.0' -DGGML_CUDA=ON -DGGML_NATIVE=OFF '-DCMAKE_CUDA_ARCHITECTURES=75;86;89' -DBUILD_SHARED_LIBS=ON -DGGML_OPENMP=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TOOLS=ON '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
if($LASTEXITCODE){throw 'CUDA configure failed'}
& $CMake --build "$BuildRoot/cuda" --config Release --target llama-server -j 4
if($LASTEXITCODE){throw 'CUDA build failed'}
& $CMake -S "$PSScriptRoot/../electron/native/character-chat" -B "$BuildRoot/owner" -G 'Visual Studio 17 2022' -A x64
if($LASTEXITCODE){throw 'Owner configure failed'}
& $CMake --build "$BuildRoot/owner" --config Release
if($LASTEXITCODE){throw 'Owner build failed'}
Write-Output 'Inspect actual PE dependencies and compare every artifact against the checked-in runtime catalog before staging. A local build never establishes a new trusted digest.'
