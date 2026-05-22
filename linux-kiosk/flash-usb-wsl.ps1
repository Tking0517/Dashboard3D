# Flash the latest Dashboard3D ISO to a USB stick using WSL `dd`.
#
# Why this script exists alongside flash-usb.ps1: the pure-PowerShell
# raw-write approach hits "Access denied" / "Device not ready" at ~88%
# of an archiso ISO write. Once enough of the new partition table is on
# disk, Windows Volume Manager re-acquires the device and yanks our
# handle. The dismount + Clear-Disk pre-pass fixes it sometimes but
# isn't reliable.
#
# WSL `--mount --bare` claims the block device at the WSL kernel level,
# so Windows can't sneak in mid-write. dd then does the raw image dump
# from inside Linux where this kind of thing has been bulletproof for
# 30 years. Trade-off: requires the archlinux WSL distro to be
# present (we already use it for the ISO build).
#
# Run elevated (Start-Process -Verb RunAs from flash-usb-launch.ps1).
param(
  [Parameter(Mandatory=$true)][int]$DiskNumber,
  [Parameter(Mandatory=$true)][string]$IsoPath,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [string]$ExpectedNameLike = "*Flash Drive*",
  [string]$WslDistro = "archlinux"
)

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 -ErrorAction Stop } catch {}
}

try {
  try { Set-Content -Path $LogPath -Value "" -Encoding utf8 -ErrorAction Stop } catch {}
  Log "WSL-dd flash start. Disk=$DiskNumber Iso=$IsoPath WSL=$WslDistro"
  Log ("Elevated:  " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

  if (-not (Test-Path -LiteralPath $IsoPath)) { Log "ERROR: ISO not found"; exit 2 }

  $d = Get-Disk -Number $DiskNumber -ErrorAction Stop
  Log ("Target: {0} | Size={1}GB | Bus={2} | Boot={3} | System={4}" -f $d.FriendlyName, [math]::Round($d.Size/1GB,1), $d.BusType, $d.IsBoot, $d.IsSystem)
  if ($d.IsBoot -or $d.IsSystem) { Log "ABORT: boot/system disk."; exit 3 }
  if ($d.BusType -ne 'USB')      { Log "ABORT: disk is not USB."; exit 4 }
  if ($d.FriendlyName -notlike $ExpectedNameLike) { Log "ABORT: FriendlyName does not match $ExpectedNameLike"; exit 5 }

  # If a previous half-flash left the disk offline, Windows hides it from
  # both Get-Partition and wsl --mount. Bring it online before doing
  # anything else so the rest of the flow has something to work with.
  if ($d.IsOffline) {
    Log "Disk is offline (likely from a previous interrupted flash); bringing it online..."
    try { Set-Disk -Number $DiskNumber -IsOffline $false -ErrorAction Stop; Log "  online OK" } catch { Log ("WARN online: " + $_.Exception.Message) }
    Start-Sleep -Milliseconds 500
  }
  if ($d.IsReadOnly) {
    try { Set-Disk -Number $DiskNumber -IsReadOnly $false -ErrorAction Stop; Log "  readonly cleared" } catch { Log ("WARN ro: " + $_.Exception.Message) }
  }

  # Dismount any existing volumes + nuke the partition table BEFORE
  # handing the disk to WSL. wsl --mount --bare doesn't itself dismount;
  # if Windows still has a handle to a volume on the disk the mount
  # will fail with "device in use".
  Log "Force-dismounting any volumes on disk..."
  try {
    Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | ForEach-Object {
      $vol = $_ | Get-Volume -ErrorAction SilentlyContinue
      if ($vol -and $vol.DriveLetter) {
        Log ("  dismount " + $vol.DriveLetter + ":")
        try { Dismount-Volume -DriveLetter $vol.DriveLetter -Force -ErrorAction Stop } catch { Log ("  WARN: " + $_.Exception.Message) }
      }
    }
  } catch {}
  # NOTE: We intentionally skip Clear-Disk on the WSL-dd path. On a
  # removable USB, Clear-Disk reliably parks the disk back offline,
  # and once it's offline `wsl --mount --bare` fails with 0x8007000f
  # ("system cannot find the drive specified"). Set-Disk -IsOffline $false
  # immediately afterwards doesn't take cleanly — Windows re-marks it
  # offline by the time wsl --mount runs. Clear-Disk was only there to
  # stop Windows from re-acquiring during a raw-write (the old
  # flash-usb.ps1 path); WSL --mount --bare hands the whole block
  # device to the WSL kernel, so Windows can't interfere mid-write
  # anyway. Dismount + bring-online is all we need here.

  # Make sure the disk is online before handing it to WSL. (The
  # previous interrupted flash often leaves it offline; we already
  # tried to fix that above, but re-check here in case anything
  # toggled it.)
  try {
    $dCheck = Get-Disk -Number $DiskNumber -ErrorAction Stop
    if ($dCheck.IsOffline) {
      Log "Disk still offline; forcing online before wsl --mount..."
      Set-Disk -Number $DiskNumber -IsOffline $false -ErrorAction Stop
      Start-Sleep -Seconds 1
    }
  } catch { Log ("WARN online-recheck: " + $_.Exception.Message) }

  # Attach the physical drive to WSL as a bare block device. After this
  # call Windows no longer sees the disk; WSL owns it until --unmount.
  $devicePath = "\\.\PHYSICALDRIVE$DiskNumber"
  Log "Attaching $devicePath to WSL --mount --bare..."
  $mountOut = & wsl --mount --bare $devicePath 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Log "ABORT: wsl --mount failed: $mountOut"; exit 6 }
  Log ("  " + ($mountOut.Trim()))

  $unmountedYet = $false
  try {
    # Find the device inside WSL. After --mount the disk lands as
    # /dev/sd<X> -- exact letter depends on the order of other block
    # devices already attached. We match on size, since the bare block
    # device has no FS to identify by.
    $expectedSizeBytes = $d.Size
    $findCmd = "lsblk -d -b -n -o NAME,SIZE,TYPE | awk -v sz=$expectedSizeBytes '`$2==sz && `$3==`"disk`" {print `"/dev/`"`$1; exit}'"
    Log "Locating device inside WSL ($WslDistro)..."
    $wslDev = & wsl -d $WslDistro -u root -- bash -lc $findCmd 2>&1 | Out-String
    $wslDev = $wslDev.Trim()
    if (-not $wslDev) { Log "ABORT: could not locate matching device inside WSL"; exit 7 }
    Log "  device inside WSL: $wslDev (expected size $expectedSizeBytes bytes)"

    # Translate ISO path: E:\VSCODE\Dashboard3D\... -> /mnt/e/VSCODE/Dashboard3D/...
    $wslIso = $IsoPath -replace '\\', '/' -replace '^([A-Za-z]):', { '/mnt/' + $_.Groups[1].Value.ToLower() }
    Log "  ISO inside WSL: $wslIso"

    # dd with 4M block size + status=progress for live MB/s output.
    # conv=fdatasync makes dd return only after the kernel has synced
    # data to the device, so we know the write actually landed before
    # we unmount.
    Log "Running dd inside WSL (this is the real write -- takes ~1-2 min)..."
    $ddCmd = "dd if='$wslIso' of='$wslDev' bs=4M status=progress conv=fdatasync; echo EXIT=`$?"
    & wsl -d $WslDistro -u root -- bash -lc $ddCmd 2>&1 | ForEach-Object {
      $line = $_
      Log "  dd: $line"
    }
    Log "dd finished."
  } finally {
    Log "Unmounting WSL bare device..."
    $unmountOut = & wsl --unmount $devicePath 2>&1 | Out-String
    Log ("  " + ($unmountOut.Trim()))
    $unmountedYet = $true
  }

  Log "DONE OK"
  Write-Host ""
  Write-Host "Flash complete via WSL dd. You can safely close this window or eject the USB."
  Read-Host "Press Enter to close"
  exit 0
}
catch {
  Log ("FATAL: " + $_.Exception.Message)
  Log ($_.ScriptStackTrace)
  Write-Host ""
  Read-Host "Flash FAILED. Press Enter to close"
  exit 99
}
