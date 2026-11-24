# 一行安装（Windows PowerShell）：
#   irm https://raw.githubusercontent.com/<owner>/video-subtitle-extractor/main/scripts/bootstrap.ps1 | iex
# 可选环境变量：
#   VSX_DEST   技能安装目录（默认 $HOME\.doubao\skills\video-subtitle-extractor）
#   VSX_REPO   owner/repo 覆盖
#   VSX_REF    分支/标签
#   VSX_MODEL  small|base|medium|large-v3|none
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Repo  = if ($env:VSX_REPO)  { $env:VSX_REPO }  else { "Zblac/video-subtitle-extractor" }
$Ref   = if ($env:VSX_REF)   { $env:VSX_REF }   else { "main" }
$Dest  = if ($env:VSX_DEST)  { $env:VSX_DEST }  else { Join-Path $HOME ".doubao\skills\video-subtitle-extractor" }
$Model = if ($env:VSX_MODEL) { $env:VSX_MODEL } else { "small" }

$Py = if ($env:VSX_PYTHON) { $env:VSX_PYTHON } else { "python" }

$tmp = Join-Path $env:TEMP ("vsx-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "[bootstrap] 下载安装器 $Repo@$Ref"
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Repo/$Ref/scripts/install.py" -OutFile (Join-Path $tmp "install.py")

  Write-Host "[bootstrap] 拉代码 + 装依赖 → $Dest"
  & $Py (Join-Path $tmp "install.py") --bootstrap --repo $Repo --ref $Ref --dest $Dest --install-deps --model $Model
  if ($LASTEXITCODE -ne 0) { throw "安装失败（退出码 $LASTEXITCODE）" }

  Write-Host "[bootstrap] 完成。用法："
  Write-Host "  node `"$Dest\ytsub.js`" `"<视频链接>`" --json"
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
