DASHBOARD3D · LibreHardwareMonitor bundle
==========================================

Drop the contents of a LibreHardwareMonitor release into THIS folder
so the dashboard's FANS panel can read your sensors automatically.

Download (official, MIT-licensed):
    https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases

After extracting the release ZIP, this folder should contain at minimum:
    LibreHardwareMonitor.exe
    LibreHardwareMonitorLib.dll
    HidSharp.dll
    LibreHardwareMonitor.sys      (driver — installed on first run)
    (and any other .dll / .pdb / .config files from the release)

On first launch, Windows will prompt to install the kernel driver that
LHM uses to read the EC / super-I/O chips. Allow it once; subsequent
launches are silent.

The dashboard spawns LHM hidden (no taskbar entry) and configures it
via LibreHardwareMonitor.exe.config to:
  - Start minimized
  - Run the HTTP server on port 8085
  - Stay in the tray (the tray icon is the one visible artifact — see
    main.js _startLhmSupervisor for the stealth caveat)

LHM is killed when the dashboard quits.

If you don't drop LHM here, the FANS panel will simply stay empty —
nothing else in the dashboard is affected.
