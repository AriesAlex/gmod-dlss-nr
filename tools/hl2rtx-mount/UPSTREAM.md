`Hl2RtxMountService.cs` and `MountConfigService.cs` are unchanged copies of
[Xenthio/RTXLauncher](https://github.com/Xenthio/RTXLauncher/tree/7779fc474d2cc4c73c8b02f031cc239159e9e8e4/RTXLauncher.Core/Services)
at commit `7779fc474d2cc4c73c8b02f031cc239159e9e8e4`. Both files were compared
byte-for-byte with that revision. The upstream repository supplies no license
file at this revision; this package does not assign a license to that code.

`Program.cs` is the portable local adapter. It creates the upstream Source
content overlay, links the original Steam HL2 RTX Remix assets, copies root
USDA files and applies the supplied USDA replacements. Existing valid mounts
are accepted without rewriting files; incomplete or mismatched mounts fail
without deletion. `--validate` only reads the target and its sources.

Build with .NET 10 SDK:

```powershell
dotnet build tools/hl2rtx-mount/Hl2RtxMount.csproj -c Release
```

Run the built DLL with three absolute paths and one operation:

```powershell
dotnet tools/hl2rtx-mount/bin/Release/net10.0/Hl2RtxMount.dll --game 'D:\Games\gmod-rtx' --hl2rtx 'D:\SteamLibrary\steamapps\common\Half-Life 2 RTX' --usda-fixes 'D:\Packages\rtx-usda-fixes\hl2rtxdemo' --apply
```

Use `--validate` instead of `--apply` for a read-only check. The fixes argument
must name the directory containing the replacement `mod.usda`, not its parent.
Symlink creation requires Windows Developer Mode or elevation. JSON stdout
statuses are `mounted`, `already-mounted` and `valid` (exit 0). Failures produce
JSON stderr with `status: "error"` and exit 1. The tool preserves unrelated
`mount.cfg` entries and refuses to apply a fresh mount while GMod from the target
directory is running. It never closes a process or sends game commands.
