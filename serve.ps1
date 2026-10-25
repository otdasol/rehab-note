# Serves this folder's pages at http://localhost:8791 (ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM)
# /  -> ot-note.html,  /design/*.webp,png (start screen, logo)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8791/")
$listener.Start()
Write-Host "Running at http://localhost:8791"
$types = @{ ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".webp" = "image/webp"; ".png" = "image/png" }
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $rel = $ctx.Request.Url.AbsolutePath.TrimStart("/")
  if (-not $rel) { $rel = "ot-note.html" }
  $ext = [System.IO.Path]::GetExtension($rel)
  $file = Join-Path $PSScriptRoot $rel
  $inside = [System.IO.Path]::GetFullPath($file).StartsWith($PSScriptRoot)
  if ($inside -and $types.ContainsKey($ext) -and (Test-Path $file -PathType Leaf)) {
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentType = $types[$ext]
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
