#Requires -Version 5.1
<#
    ocr.ps1 - Windows built-in OCR (offline), with image preprocessing

    Pipeline:
      1. Trim blank borders
      2. Variant A: cropped + scaled to target width
      3. Variant B: A + grayscale, contrast boosted
      4. Variant C: A downscaled to ~62% (some glyphs read better smaller)
      5. Variant S: left column strip, upscaled (recovers missed train codes)
      6. OCR every variant, return all of them + the best one

    Output JSON:
      { ok, width, height, scale, crop, variant, score,
        lines: [...], variants: [ {tag,width,height,score,lines} ],
        stripVariant: { height, lines } }

    Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path a.png -OutFile a.json

    Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [double]$Scale = 0,
    [int]$TargetWidth = 1700,
    [int]$MaxWidth = 4000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Fail([string]$msg) {
    $payload = @{ ok = $false; error = $msg }
    $json = $payload | ConvertTo-Json -Compress -Depth 4
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
    exit 1
}

function Save-Bitmap([System.Drawing.Bitmap]$bmp, [string]$prefix) {
    $file = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ($prefix + [guid]::NewGuid().ToString('N') + ".png"))
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    return $file
}

try {
    if (-not (Test-Path $Path)) { Write-Fail "image not found: $Path" }

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

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    if (-not $engine) { Write-Fail 'no OCR language pack available' }

    # ---------------- trim blank borders ----------------
    $bmp = [System.Drawing.Bitmap]::FromFile($Path)
    $imgW = $bmp.Width
    $imgH = $bmp.Height
    $step = [Math]::Max(1, [int]($imgW / 200))

    $top = 0
    for ($y = 0; $y -lt $imgH; $y += $step) {
        $blank = $true
        for ($x = 0; $x -lt $imgW; $x += $step) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -lt 242 -or $c.G -lt 242 -or $c.B -lt 242) { $blank = $false; break }
        }
        $top = $y
        if (-not $blank) { $top = [Math]::Max(0, $y - $step); break }
    }

    $bottom = $imgH - 1
    for ($y = $imgH - 1; $y -ge $top; $y -= $step) {
        $blank = $true
        for ($x = 0; $x -lt $imgW; $x += $step) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -lt 242 -or $c.G -lt 242 -or $c.B -lt 242) { $blank = $false; break }
        }
        $bottom = $y
        if (-not $blank) { $bottom = [Math]::Min($imgH - 1, $y + $step); break }
    }

    $left = 0
    for ($x = 0; $x -lt $imgW; $x += $step) {
        $blank = $true
        for ($y = $top; $y -le $bottom; $y += $step) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -lt 242 -or $c.G -lt 242 -or $c.B -lt 242) { $blank = $false; break }
        }
        $left = $x
        if (-not $blank) { $left = [Math]::Max(0, $x - $step); break }
    }

    $right = $imgW - 1
    for ($x = $imgW - 1; $x -ge $left; $x -= $step) {
        $blank = $true
        for ($y = $top; $y -le $bottom; $y += $step) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -lt 242 -or $c.G -lt 242 -or $c.B -lt 242) { $blank = $false; break }
        }
        $right = $x
        if (-not $blank) { $right = [Math]::Min($imgW - 1, $x + $step); break }
    }

    $cropW = $right - $left
    $cropH = $bottom - $top
    if ($cropW -lt 20 -or $cropH -lt 20) {
        $left = 0; $top = 0; $cropW = $imgW; $cropH = $imgH
    }

    $cropRect = New-Object System.Drawing.Rectangle($left, $top, $cropW, $cropH)
    $cropped = $bmp.Clone($cropRect, $bmp.PixelFormat)

    # ---------------- scale ----------------
    $scaleFactor = 1.0
    if ($Scale -gt 0) {
        $scaleFactor = $Scale
    } elseif ($cropped.Width -lt $TargetWidth) {
        $scaleFactor = [Math]::Min(3.0, $TargetWidth / $cropped.Width)
    }
    if ($cropped.Width * $scaleFactor -gt $MaxWidth) {
        $scaleFactor = [Math]::Max(1.0, $MaxWidth / $cropped.Width)
    }

    $baseW = [int][Math]::Max(8, [Math]::Round($cropped.Width * $scaleFactor))
    $baseH = [int][Math]::Max(8, [Math]::Round($cropped.Height * $scaleFactor))
    $margin = [int][Math]::Max(10, [Math]::Round($baseH * 0.04))

    # ---------------- render variants ----------------
    function Render-Variant([int]$vw, [int]$vh, [bool]$enhance) {
        $canvasW = $vw + $margin * 2
        $canvasH = $vh + $margin * 2
        $dst = New-Object System.Drawing.Bitmap($canvasW, $canvasH)
        $g = [System.Drawing.Graphics]::FromImage($dst)
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        if ($enhance) {
            $c = 1.55
            $cm = New-Object System.Drawing.Imaging.ColorMatrix
            $cm.Matrix00 = 0.299 * $c; $cm.Matrix01 = 0.299 * $c; $cm.Matrix02 = 0.299 * $c
            $cm.Matrix10 = 0.587 * $c; $cm.Matrix11 = 0.587 * $c; $cm.Matrix12 = 0.587 * $c
            $cm.Matrix20 = 0.114 * $c; $cm.Matrix21 = 0.114 * $c; $cm.Matrix22 = 0.114 * $c
            $cm.Matrix33 = 1.0
            $off = (1.0 - $c) / 2.0
            $cm.Matrix40 = $off; $cm.Matrix41 = $off; $cm.Matrix42 = $off
            $ia = New-Object System.Drawing.Imaging.ImageAttributes
            $ia.SetColorMatrix($cm)
            $destRect = New-Object System.Drawing.Rectangle($margin, $margin, $vw, $vh)
            $g.DrawImage($cropped, $destRect, 0, 0, $cropped.Width, $cropped.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
            $ia.Dispose()
        } else {
            $g.DrawImage($cropped, $margin, $margin, $vw, $vh)
        }

        $g.Dispose()
        $file = Save-Bitmap $dst 'ocr_v_'
        $dst.Dispose()
        return $file
    }

    $variantFiles = @()
    $variantTags = @()

    $variantFiles += Render-Variant $baseW $baseH $false
    $variantTags += 'A'
    $variantFiles += Render-Variant $baseW $baseH $true
    $variantTags += 'B'
    $variantFiles += Render-Variant ([int][Math]::Max(320, [Math]::Round($baseW * 0.62))) ([int][Math]::Max(60, [Math]::Round($baseH * 0.62))) $false
    $variantTags += 'C'

    # strip variant: left column only
    $stripW = [int][Math]::Round($cropW * 0.26)
    $stripAdded = $false
    if ($stripW -gt 40 -and $stripW -lt $cropW) {
        $stripScale = [Math]::Min(4.0, [Math]::Max(1.0, 900.0 / $stripW))
        $sW = [int][Math]::Max(320, [Math]::Round($stripW * $stripScale))
        $sH = [int][Math]::Max(80, [Math]::Round($cropH * $stripScale))
        $sb = New-Object System.Drawing.Bitmap($sW, $sH)
        $sg = [System.Drawing.Graphics]::FromImage($sb)
        $sg.Clear([System.Drawing.Color]::White)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $sW, $sH)
        $sg.DrawImage($cropped, $destRect, 0, 0, $stripW, $cropH, [System.Drawing.GraphicsUnit]::Pixel)
        $sg.Dispose()
        $variantFiles += Save-Bitmap $sb 'ocr_s_'
        $sb.Dispose()
        $variantTags += 'S'
        $stripAdded = $true
    }

    # ---------------- run OCR on every variant ----------------
    $allVariants = @()
    $stripVariant = $null
    $bestLines = $null
    $bestScore = -1
    $bestTag = ''
    $bestW = $baseW
    $bestH = $baseH

    for ($i = 0; $i -lt $variantFiles.Count; $i++) {
        $file = $variantFiles[$i]
        $tag = $variantTags[$i]
        $rows = @()
        $score = 0
        $dw = 0
        $dh = 0

        try {
            $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
            $ss = Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ss)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $dw = $decoder.PixelWidth
            $dh = $decoder.PixelHeight
            $sbm = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $res = Await ($engine.RecognizeAsync($sbm)) ([Windows.Media.Ocr.OcrResult])

            foreach ($line in @($res.Lines)) {
                $words = @($line.Words)
                if ($words.Count -eq 0) { continue }
                $first = $words[0]
                $last = $words[$words.Count - 1]
                $lx = [int][Math]::Round($first.BoundingRect.X)
                $ly = [int][Math]::Round($first.BoundingRect.Y)
                $lw = [int][Math]::Round(($last.BoundingRect.X + $last.BoundingRect.Width) - $lx)
                $lh = [int][Math]::Round($first.BoundingRect.Height)
                $rows += [ordered]@{
                    text = [string]$line.Text
                    x    = $lx
                    y    = $ly
                    w    = $lw
                    h    = $lh
                }
                $score += ([string]$line.Text).Length
            }
        } catch {
            Write-Fail ('OCR failed on variant ' + $tag + ': ' + $_.Exception.Message)
        }

        if ($tag -eq 'S') {
            $stripVariant = [ordered]@{ height = $dh; lines = $rows }
        } else {
            $allVariants += [ordered]@{
                tag = $tag; width = $dw; height = $dh; score = $score; lines = $rows
            }
        }

        if ($tag -ne 'S' -and $score -gt $bestScore) {
            $bestScore = $score
            $bestLines = $rows
            $bestTag = $tag
            $bestW = $dw
            $bestH = $dh
        }
    }

    foreach ($f in $variantFiles) { Remove-Item $f -ErrorAction SilentlyContinue }

    if ($null -eq $bestLines) { Write-Fail 'OCR returned no text' }

    $payload = [ordered]@{
        ok           = $true
        width        = $bestW
        height       = $bestH
        scale        = [Math]::Round($scaleFactor, 2)
        crop         = "$cropW x $cropH"
        variant      = $bestTag
        score        = $bestScore
        lines        = $bestLines
        variants     = $allVariants
        stripVariant = $stripVariant
        stripAdded   = $stripAdded
    }

    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
    exit 0
} catch {
    Write-Fail ($_.Exception.Message)
}
