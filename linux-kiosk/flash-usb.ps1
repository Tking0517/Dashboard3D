# Raw-write the latest Dashboard3D ISO to a specific physical disk.
# Invoked elevated by the parent build flow; ONLY targets the disk number
# passed in -DiskNumber and only after verifying it matches the expected
# FriendlyName pattern and is NOT marked IsBoot/IsSystem. Writes a status
# log so the parent can tail progress without sharing the elevated stdout.
param(
  [Parameter(Mandatory=$true)][int]$DiskNumber,
  [Parameter(Mandatory=$true)][string]$IsoPath,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [string]$ExpectedNameLike = "*Flash Drive*"
)

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop } catch {
    # Fallback so we never silently lose progress if the primary log path is unwritable.
    Add-Content -Path "$env:TEMP\dashboard3d-flash-usb.log" -Value $line -Encoding utf8
  }
}

try {
  # Wipe the log first so a stale entry from a previous run can't confuse us.
  try { Set-Content -Path $LogPath -Value "" -Encoding utf8 -ErrorAction Stop } catch {}
  Log "Flash start. Disk=$DiskNumber Iso=$IsoPath"
  Log ("Running as: " + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  Log ("Elevated:   " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  Log ("Cwd:        " + (Get-Location).Path)

  if (-not (Test-Path -LiteralPath $IsoPath)) { Log "ERROR: ISO not found"; exit 2 }

  $d = Get-Disk -Number $DiskNumber -ErrorAction Stop
  Log ("Target: {0} | Size={1}GB | Bus={2} | Boot={3} | System={4}" -f $d.FriendlyName, [math]::Round($d.Size/1GB,1), $d.BusType, $d.IsBoot, $d.IsSystem)

  if ($d.IsBoot -or $d.IsSystem) { Log "ABORT: Refusing to write to a boot/system disk."; exit 3 }
  if ($d.BusType -ne 'USB')      { Log "ABORT: Disk is not a USB device."; exit 4 }
  if ($d.FriendlyName -notlike $ExpectedNameLike) { Log "ABORT: FriendlyName does not match $ExpectedNameLike"; exit 5 }

  # If a previous half-flash (or a failed wsl --mount attempt) left the
  # disk in the offline state, Windows refuses to open the raw
  # \\.\PhysicalDriveN handle. Force it online first.
  if ($d.IsOffline) {
    Log "Disk is offline (likely from a previous interrupted flash); bringing it online..."
    try { Set-Disk -Number $DiskNumber -IsOffline $false -ErrorAction Stop; Log "  online OK" } catch { Log ("WARN online: " + $_.Exception.Message) }
    Start-Sleep -Milliseconds 750
  }

  # Removable USB sticks refuse Set-Disk -IsOffline, so we have to coax
  # Windows' volume manager out of the way by force-dismounting every
  # volume on the disk and then nuking the partition table with
  # Clear-Disk. Without this, the moment we write a new GPT header at
  # offset 0 the OS re-enumerates the device, yanks our file handle, and
  # the raw write dies with "The device is not ready" mid-stream.
  Log "Force-dismounting any volumes on disk..."
  try {
    Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | ForEach-Object {
      $part = $_
      try {
        $vol = $part | Get-Volume -ErrorAction SilentlyContinue
        if ($vol -and $vol.DriveLetter) {
          Log ("  dismount " + $vol.DriveLetter + ":")
          Dismount-Volume -DriveLetter $vol.DriveLetter -Force -ErrorAction Stop
        } elseif ($vol -and $vol.UniqueId) {
          Log ("  dismount " + $vol.UniqueId)
          Dismount-Volume -InputObject $vol -Force -ErrorAction Stop
        } else {
          Log ("  partition " + $part.PartitionNumber + " has no mounted volume; skipping")
        }
      } catch { Log ("  WARN dismount: " + $_.Exception.Message) }
    }
  } catch { Log ("WARN dismount-enum: " + $_.Exception.Message) }

  Log "Clearing partition table so Windows stops watching this disk..."
  try { Clear-Disk -Number $DiskNumber -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop; Log "  Clear-Disk OK" } catch { Log ("WARN Clear-Disk: " + $_.Exception.Message) }
  Start-Sleep -Milliseconds 750
  try { Set-Disk -Number $DiskNumber -IsReadOnly $false -ErrorAction Stop } catch { Log "WARN ro: $_" }

  $isoLen = (Get-Item -LiteralPath $IsoPath).Length
  Log ("ISO size: {0} bytes ({1:N1} MB)" -f $isoLen, ($isoLen/1MB))

  # Two-pass write to dodge the Windows volume-manager race that kills
  # the handle at ~88% on this hardware:
  #   pass 1: write everything from offset 4 MiB to end of ISO
  #   pass 2: seek back to 0, write the first 4 MiB (MBR + GPT primary
  #           header + isohybrid boot sectors)
  # Windows can't mount what it doesn't recognise as a disk, and without
  # the first 4 MiB there's no MBR signature for Volume Manager to spot.
  # By the time we write the head, the body is already on disk and the
  # OS can re-enumerate cleanly after we close the handle.
  $HEAD_BYTES = 4 * 1024 * 1024
  $src = [System.IO.File]::OpenRead($IsoPath)
  $dst = $null
  try {
    $dst = [System.IO.File]::Open("\\.\PhysicalDrive$DiskNumber", [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $buf = New-Object byte[] (4 * 1024 * 1024)
    $total = 0L
    $lastReportMb = -1
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # ── Pass 1: write body (skip first HEAD_BYTES) ──────────────────
    Log ("Pass 1/2: writing body (offsets {0}..end)" -f $HEAD_BYTES)
    $src.Position = $HEAD_BYTES
    $dst.Position = $HEAD_BYTES
    while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) {
      $dst.Write($buf, 0, $read)
      $total += $read
      $mb = [int](($total + $HEAD_BYTES) / 1MB)
      if ($mb -ge $lastReportMb + 50) {
        $pct = [math]::Round((($total + $HEAD_BYTES) / $isoLen) * 100, 1)
        $mbps = if ($sw.Elapsed.TotalSeconds -gt 0) { [math]::Round(($total / 1MB) / $sw.Elapsed.TotalSeconds, 1) } else { 0 }
        Log ("Progress {0}% | {1} MB / {2} MB | {3} MB/s" -f $pct, $mb, [int]($isoLen/1MB), $mbps)
        $lastReportMb = $mb
      }
    }
    $dst.Flush($true)
    Log "Pass 1 flush complete."

    # ── Pass 2: write head (first HEAD_BYTES) ───────────────────────
    # HEAD_BYTES (4 MiB) is always smaller than the ISO, and small
    # enough to fit Int32 — so no Math.Min overload juggling needed.
    Log "Pass 2/2: writing head (offsets 0..$HEAD_BYTES)"
    $src.Position = 0
    $dst.Position = 0
    [int]$headRemaining = $HEAD_BYTES
    while ($headRemaining -gt 0) {
      $toRead = if ($buf.Length -lt $headRemaining) { $buf.Length } else { $headRemaining }
      $read = $src.Read($buf, 0, $toRead)
      if ($read -le 0) { break }
      $dst.Write($buf, 0, $read)
      $headRemaining -= $read
    }
    $dst.Flush($true)
    Log "Pass 2 flush complete."
  } finally {
    if ($dst) { $dst.Close() }
    $src.Close()
  }

  # Removable media can't be set IsOffline=$true (and therefore can't be
  # set back to $false either) — no-op needed. Windows will rescan and
  # surface the ISO9660 partition once the device is unplugged + replugged
  # OR ejected via Explorer once we close our handle.
  Log "Write phase finished; Windows will rescan the device on next access."

  Log "DONE OK"
  Write-Host ""
  Write-Host "Flash complete. You can safely close this window or eject the USB."
  Read-Host "Press Enter to close"
  exit 0
}
catch {
  Log ("FATAL: " + $_.Exception.Message)
  Log ($_.ScriptStackTrace)
  Write-Host ""
  Write-Host "Flash FAILED. See log above and at $LogPath."
  Read-Host "Press Enter to close"
  exit 99
}
