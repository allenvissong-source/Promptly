Add-Type -AssemblyName System.Windows.Forms
$obj = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -eq $obj) { Write-Output "(clipboard empty)"; return }

# Read HTML Format as RAW BYTES (it comes back as a MemoryStream for custom
# formats). Casting to [string] would decode with the ANSI codepage and mangle
# UTF-8 -> we want the true bytes to know what the app actually wrote.
$data = $obj.GetData('HTML Format', $false)
if ($data -is [System.IO.MemoryStream]) {
  $bytes = $data.ToArray()
} elseif ($data -is [byte[]]) {
  $bytes = $data
} else {
  Write-Output "HTML Format type: $($data.GetType().FullName)"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$data)
}
Write-Output "=== HTML Format raw byte length = $($bytes.Length) ==="
# Decode the bytes BOTH ways so we can see which one yields correct Chinese.
Write-Output "--- decoded as UTF-8 ---"
Write-Output ([System.Text.Encoding]::UTF8.GetString($bytes))
Write-Output ""
Write-Output "--- first 160 bytes (hex) ---"
($bytes[0..([Math]::Min(159,$bytes.Length-1))] | ForEach-Object { $_.ToString('x2') }) -join ' '
Write-Output ""
# Verify the referenced files actually exist on disk.
Write-Output "--- file existence (FileDrop) ---"
if ($obj.GetDataPresent('FileDrop')) {
  foreach ($p in $obj.GetData('FileDrop')) {
    Write-Output ("{0}  ->  {1}" -f (Test-Path -LiteralPath $p), $p)
  }
}
