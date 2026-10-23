#Requires -Version 5.1
<#
    ocr.ps1 —— 调用 Windows 自带 OCR 引擎识别图片中的文字（完全离线）

    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path "a.png" -OutFile "a.json"

    输出 JSON：
      { "ok": true, "width": 1680, "height": 1040,
        "lines": [ { "text": "G1", "x": 50, "y": 73, "w": 40, "h": 22 }, ... ] }

    说明：
      - 使用 Windows.Media.Ocr（与系统「截图工具」提取文字同款引擎），不联网。
      - 小图会自动放大 2 倍再识别，提升小字号准确率。
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [double]$Scale = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Fail($msg) {
    $payload = @{ ok = $false; error = $msg }
    $json = $payload | ConvertTo-Json -Compress -Depth 4
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
    exit 1
}

try {
    if (-not (Test-Path $Path)) { Write-Fail "图片不存在: $Path" }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -AssemblyName System.Drawing

    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]

    function Await($op, $type) {
        $asTask = $asTaskGeneric.MakeGenericMethod($type)
        $netTask = $asTask.Invoke($null, @($op))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }

    # ---- 按需放大，小字号截图识别率会明显提升 ----
    $img = [System.Drawing.Image]::FromFile($Path)
    $w0 = $img.Width; $h0 = $img.Height
    $img.Dispose()

    if ($Scale -le 0) { $Scale = if ($w0 -lt 900) { 2 } else { 1 } }
    if ($Scale -gt 1) {
        if ($w0 * $Scale -gt 9000) {
            $Scale = [Math]::Min($Scale, [Math]::Floor(9000 / $w0))
        }
    }

    if ($Scale -gt 1.01) {
        $src = [System.Drawing.Image]::FromFile($Path)
        $nw = [int][Math]::Round($src.Width * $Scale)
        $nh = [int][Math]::Round($src.Height * $Scale)
        $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src, 0, 0, $nw, $nh)
        $scaled = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("ocr_" + [guid]::NewGuid().ToString('N') + ".png"))
        $bmp.Save($scaled, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose(); $src.Dispose()
        $Path = $scaled
    }

    # ---- 识别 ----
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    if (-not $engine) { Write-Fail '系统未安装可用的 OCR 语言包（需要中文识别支持）' }

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($line in @($result.Lines)) {
        $words = @($line.Words)
        if ($words.Count -eq 0) { continue }
        $first = $words[0]
        $last = $words[$words.Count - 1]
        $x = [int][Math]::Round($first.BoundingRect.X)
        $y = [int][Math]::Round($first.BoundingRect.Y)
        $right = $last.BoundingRect.X + $last.BoundingRect.Width
        $h = [int][Math]::Round($first.BoundingRect.Height)
        $rows.Add([ordered]@{
                text = [string]$line.Text
                x    = $x
                y    = $y
                w    = [int][Math]::Round($right - $x)
                h    = $h
            })
    }

    $payload = [ordered]@{
        ok     = $true
        width  = $decoder.PixelWidth
        height = $decoder.PixelHeight
        scale  = $Scale
        lines  = $rows
    }

    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
    exit 0
}
catch {
    Write-Fail ($_.Exception.Message)
}
