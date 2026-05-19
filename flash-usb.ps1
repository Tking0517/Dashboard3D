# Dashboard3D appliance USB flasher — run elevated (Administrator).
# Cleans and raw-writes the appliance ISO to the 119 GB USB stick.
#
# The target is AUTO-DETECTED as the one removable USB disk of ~119 GB
# (the disk number shifts when Windows re-enumerates it). Hard safety:
# only a USB-bus disk of 100-130 GB is ever eligible, so it physically
# cannot match an NVMe drive or the big external SSD.
$ErrorActionPreference = 'Stop'
Start-Transcript -Path 'E:\VSCODE\Dashboard3D\flash-usb.log' -Force | Out-Null

$isoDir = 'E:\VSCODE\Dashboard3D\linux-kiosk\iso-build\out'

function Fail($m) { Write-Host "ABORT: $m"; try { 'automount enable' | diskpart | Out-Null } catch {}; try { Stop-Transcript | Out-Null } catch {}; Read-Host "Press Enter to close"; exit 1 }

Write-Host "=== Dashboard3D USB flasher (raw write) ==="

# Pick the newest dashboard3d ISO (the filename carries a build date).
$isoFile = Get-ChildItem -Path $isoDir -Filter 'dashboard3d-*.iso' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $isoFile) { Fail "no dashboard3d-*.iso found in $isoDir" }
$iso = $isoFile.FullName
Write-Host ("ISO    : {0}" -f (Split-Path $iso -Leaf))

# Auto-detect: a USB disk of ~119 GB. NVMe (wrong bus) and the 3.8 TB
# external SSD (wrong size) can never match.
$cands = @(Get-Disk | Where-Object {
  $_.BusType -eq 'USB' -and ($_.Size / 1GB) -ge 100 -and ($_.Size / 1GB) -le 130
})
if ($cands.Count -eq 0) { Fail "no ~119 GB USB disk found - is the stick plugged in?" }
if ($cands.Count -gt 1) { Fail "more than one ~119 GB USB disk found - unplug the extra one." }
$d = $cands[0]
$disk = $d.Number
$gb = [math]::Round($d.Size / 1GB, 0)
Write-Host ("Target : Disk {0}  '{1}'  {2} GB  bus={3}" -f $d.Number, $d.FriendlyName, $gb, $d.BusType)

if (-not (Test-Path $iso)) { Fail "ISO not found: $iso" }

$isoSize = (Get-Item $iso).Length
Write-Host ("ISO    : {0} GB" -f [math]::Round($isoSize / 1GB, 2))
Write-Host ""

# Removable USB sticks cannot be set offline; Clear-Disk wipes the
# partition table instead, which dismounts the volume so the raw write
# is clean.
# Stop Windows auto-mounting the ISO's partitions as they get written.
# A mounted volume makes Windows deny raw writes to its sectors, so the
# write otherwise dies partway through with "Access denied".
Write-Host "Disabling volume auto-mount for the write..."
'automount disable' | diskpart | Out-Null

Write-Host "Wiping the USB partition table (Clear-Disk)..."
try { Clear-Disk -Number $disk -RemoveData -RemoveOEM -Confirm:$false } catch {
  Write-Host "  (Clear-Disk note: $($_.Exception.Message))"
}
Start-Sleep -Seconds 2

$path = "\\.\PHYSICALDRIVE$disk"
$src = $null; $dst = $null
try {
  $src = [System.IO.File]::OpenRead($iso)
  $dst = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)

  $bufSize = 4194304               # 4 MiB, sector-aligned
  $buf = New-Object byte[] $bufSize
  $written = 0L
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  # Write the FIRST 4 MiB LAST. While sector 0 (the partition table) is
  # still zero, Windows cannot recognise or mount the disk, so it never
  # locks — and denies writes to — any sectors. After the bulk of the
  # image is down, the first block is laid and the partitions appear.
  Write-Host "Writing the ISO (first block deferred) ..."
  $firstBuf = New-Object byte[] $bufSize
  $firstN = $src.Read($firstBuf, 0, $bufSize)
  $written = [int64]$firstN
  $dst.Seek([int64]$bufSize, [System.IO.SeekOrigin]::Begin) | Out-Null

  while (($n = $src.Read($buf, 0, $bufSize)) -gt 0) {
    $w = $n
    if (($w % 4096) -ne 0) {
      $w = [int]([math]::Ceiling($n / 4096.0) * 4096)   # pad up to a 4K boundary
      [Array]::Clear($buf, $n, $w - $n)                 # zero the padding
    }
    $dst.Write($buf, 0, $w)
    $written += $n
    if ($sw.Elapsed.TotalSeconds -ge 2) {
      Write-Host ("  {0} / {1} MB" -f [int]($written / 1MB), [int]($isoSize / 1MB))
      $sw.Restart()
    }
  }
  # Lay down the first block last — this is what makes the disk mountable.
  Write-Host "  writing the first block (partition table) ..."
  $dst.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
  $dst.Write($firstBuf, 0, $firstN)
  $dst.Flush()
}
catch {
  if ($dst) { $dst.Close() }; if ($src) { $src.Close() }
  Fail "write failed: $($_.Exception.Message)"
}
$dst.Close(); $src.Close()

Write-Host ("Wrote {0} MB." -f [int]($written / 1MB))

# --- verify ------------------------------------------------------------------
# A flaky stick can ACK writes it never persists (the symptom: the USB boots
# the loader but the live filesystem is missing). So read the USB back and
# SHA-256 compare it against the ISO. SUCCESS is printed only on a match.
Write-Host ""
Write-Host "Verifying the USB (reading it back - this takes a minute)..."

# Bytes actually written: the ISO padded up to a 4 KiB boundary.
$padded = [int64]([math]::Ceiling($isoSize / 4096.0) * 4096)
$vbuf = New-Object byte[] $bufSize

# Hash 1: the ISO content followed by the same zero padding the writer added.
$shaIso = [System.Security.Cryptography.SHA256]::Create()
$s = [System.IO.File]::OpenRead($iso)
while (($n = $s.Read($vbuf, 0, $bufSize)) -gt 0) { [void]$shaIso.TransformBlock($vbuf, 0, $n, $null, 0) }
$s.Close()
$padBytes = [int]($padded - $isoSize)
if ($padBytes -gt 0) { [void]$shaIso.TransformBlock((New-Object byte[] $padBytes), 0, $padBytes, $null, 0) }
[void]$shaIso.TransformFinalBlock((New-Object byte[] 0), 0, 0)
$isoHash = [BitConverter]::ToString($shaIso.Hash).Replace('-', '')

# Hash 2: the same number of bytes read back from the raw USB device.
$shaUsb = [System.Security.Cryptography.SHA256]::Create()
$chk = $null
try {
  $chk = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
  $remaining = $padded
  $vread = 0L
  $sw.Restart()
  while ($remaining -gt 0) {
    $want = [int][math]::Min([int64]$bufSize, $remaining)
    $got = $chk.Read($vbuf, 0, $want)
    if ($got -ne $want) { throw "USB ended early at $([int]($vread / 1MB)) MB - the write did not complete." }
    [void]$shaUsb.TransformBlock($vbuf, 0, $got, $null, 0)
    $vread += $got
    $remaining -= $got
    if ($sw.Elapsed.TotalSeconds -ge 2) {
      Write-Host ("  verified {0} / {1} MB" -f [int]($vread / 1MB), [int]($padded / 1MB))
      $sw.Restart()
    }
  }
}
catch { if ($chk) { $chk.Close() }; Fail "verify failed: $($_.Exception.Message)" }
$chk.Close()
[void]$shaUsb.TransformFinalBlock((New-Object byte[] 0), 0, 0)
$usbHash = [BitConverter]::ToString($shaUsb.Hash).Replace('-', '')

if ($usbHash -ne $isoHash) {
  Fail "VERIFY MISMATCH - the USB is not a correct copy of the ISO. Re-run the flasher; if it keeps failing, the USB stick is bad."
}
Write-Host "Verify OK - the USB is a byte-perfect copy of the ISO."

'automount enable' | diskpart | Out-Null

Write-Host ""
Write-Host "=== SUCCESS - the 119 GB USB now boots Dashboard3D. ==="
try { Stop-Transcript | Out-Null } catch {}
Read-Host "Press Enter to close"
exit 0
