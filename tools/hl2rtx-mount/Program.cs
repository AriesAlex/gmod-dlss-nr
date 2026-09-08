using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using RTXLauncher.Core.Services;

try
{
    if (args.Length == 1 && args[0] == "--help")
    {
        Console.WriteLine("Hl2RtxMount --game PATH --hl2rtx PATH --usda-fixes PATH (--apply | --validate)");
        return 0;
    }

    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    string? mode = null;
    for (var index = 0; index < args.Length; index++)
    {
        var argument = args[index];
        if (argument is "--apply" or "--validate")
        {
            if (mode != null) throw new ArgumentException("Specify exactly one of --apply or --validate.");
            mode = argument;
        }
        else if (argument is "--game" or "--hl2rtx" or "--usda-fixes")
        {
            if (++index == args.Length || args[index].StartsWith("--", StringComparison.Ordinal) ||
                !options.TryAdd(argument, Path.GetFullPath(args[index])))
                throw new ArgumentException($"Missing or repeated value for {argument}.");
        }
        else throw new ArgumentException($"Unknown argument: {argument}");
    }
    if (mode == null || options.Count != 3)
        throw new ArgumentException("Required: --game PATH --hl2rtx PATH --usda-fixes PATH and --apply or --validate.");

    var game = options["--game"];
    var source = options["--hl2rtx"];
    var fixes = options["--usda-fixes"];
    if (IsWithin(source, game) || IsWithin(game, source) || IsWithin(fixes, game))
        throw new ArgumentException("The game, source HL2 RTX installation and USDA fixes must use separate directories.");

    var layout = Hl2RtxMountService.ValidateLayout(source, game);
    var remixSource = Path.Combine(source, "rtx-remix", "mods", "hl2rtx");
    var remixTarget = Path.Combine(game, "rtx-remix", "mods", "mount-hl2rtx-hl2rtx");
    var configPath = Path.Combine(game, "garrysmod", "cfg", "mount.cfg");
    if (!File.Exists(Path.Combine(remixSource, "mod.usda")))
        throw new FileNotFoundException($"HL2 RTX Remix assets are incomplete: {remixSource}");
    if (!File.Exists(Path.Combine(fixes, "mod.usda")))
        throw new FileNotFoundException($"--usda-fixes must point to the fixes folder containing mod.usda: {fixes}");

    var originalBytes = MountConfigService.ReadBytesOrDefault(configPath);
    var original = MountConfigService.Decode(originalBytes, out var encoding);
    var hasMount = Path.Exists(remixTarget) ||
        Path.Exists(Path.Combine(layout.CompatibilityAddonPath, Hl2RtxMountService.ManifestFileName)) ||
        Hl2RtxMountService.GeneratedOverlayRoots.Any(root => Path.Exists(Path.Combine(layout.CompatibilityAddonPath, root))) ||
        Regex.IsMatch(original, @"(?m)^[ \t]*""rtxlauncher_hl2rtx[^""]*""[ \t]+""");

    if (mode == "--validate" || hasMount)
    {
        ValidateMount(layout, remixSource, remixTarget, fixes, configPath);
        Console.WriteLine(JsonSerializer.Serialize(new { status = mode == "--validate" ? "valid" : "already-mounted", game, source }));
        return 0;
    }

    // Preflight everything before creating links or updating mount.cfg.
    foreach (var process in Process.GetProcessesByName("gmod"))
    {
        using (process)
        {
            string? executable;
            try { executable = process.MainModule?.FileName; }
            catch (InvalidOperationException) { continue; } // Process exited during inspection.
            if (executable == null) throw new InvalidOperationException($"Cannot inspect gmod process {process.Id}.");
            if (IsWithin(executable, game))
                throw new InvalidOperationException($"Close GMod from this target before applying the mount: {executable}");
        }
    }
    foreach (var target in new[] { layout.CompatibilityAddonPath, remixTarget, configPath })
        RequirePhysicalPath(game, target);
    var updated = MountConfigService.UpdateManagedEntries(original, Hl2RtxMountService.BuildMountEntries(layout));

    Hl2RtxMountService.BuildOverlay(layout, layout.CompatibilityAddonPath);
    Directory.CreateDirectory(remixTarget);
    foreach (var directory in Directory.GetDirectories(remixSource))
        Directory.CreateSymbolicLink(Path.Combine(remixTarget, Path.GetFileName(directory)), directory);
    foreach (var file in Directory.GetFiles(remixSource).Concat(Directory.GetFiles(fixes, "*.usda"))
        .DistinctBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase))
    {
        var destination = Path.Combine(remixTarget, Path.GetFileName(file));
        if (Path.GetExtension(file).Equals(".usda", StringComparison.OrdinalIgnoreCase))
        {
            var replacement = Path.Combine(fixes, Path.GetFileName(file));
            File.Copy(File.Exists(replacement) ? replacement : file, destination);
        }
        else File.CreateSymbolicLink(destination, file);
    }
    MountConfigService.WriteAtomic(configPath, MountConfigService.Encode(updated, encoding));
    ValidateMount(layout, remixSource, remixTarget, fixes, configPath);
    Console.WriteLine(JsonSerializer.Serialize(new { status = "mounted", game, source }));
    return 0;
}
catch (Exception exception)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new
    {
        status = "error",
        error = exception.Message,
        recovery = "No existing overlay is deleted or replaced. Inspect any incomplete or mismatched mount before retrying."
    }));
    return 1;
}

static void ValidateMount(Hl2RtxMountLayout layout, string remixSource, string remixTarget, string fixes, string configPath)
{
    var errors = Hl2RtxMountService.GetMountValidationErrors(layout, remixTarget, configPath);
    if (errors.Count != 0) throw new InvalidDataException(string.Join("\n", errors));

    using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(layout.CompatibilityAddonPath, Hl2RtxMountService.ManifestFileName)));
    foreach (var entry in new[]
    {
        ("installPath", layout.InstallPath),
        ("baseContentPath", layout.SourceContentPath),
        ("hl2MiscVpkPath", layout.Hl2MiscVpkPath)
    })
    {
        if (!manifest.RootElement.TryGetProperty(entry.Item1, out var value) || !PathsEqual(value.GetString() ?? "", entry.Item2))
            throw new InvalidDataException($"Overlay manifest has a different {entry.Item1}; existing mount was not changed.");
    }
    var customPaths = manifest.RootElement.GetProperty("customContentPaths").EnumerateArray().Select(value => value.GetString() ?? "").ToArray();
    if (customPaths.Length != layout.CustomContentPaths.Count ||
        customPaths.Where((path, index) => !PathsEqual(path, layout.CustomContentPaths[index])).Any())
        throw new InvalidDataException("Overlay custom sources changed; inspect and rebuild the mount explicitly.");

    var config = MountConfigService.Decode(File.ReadAllBytes(configPath), out _);
    var expectedKeys = Hl2RtxMountService.BuildMountEntries(layout).Select(entry => entry.Key).Order(StringComparer.Ordinal).ToArray();
    var actualKeys = Regex.Matches(config, @"(?m)^[ \t]*""(?<key>rtxlauncher_hl2rtx[^""]*)""[ \t]+""")
        .Select(match => match.Groups["key"].Value).Order(StringComparer.Ordinal).ToArray();
    if (!actualKeys.SequenceEqual(expectedKeys))
        throw new InvalidDataException("mount.cfg has duplicate or unexpected managed entries.");

    var sources = layout.CustomContentPaths.Concat(new[] { layout.SourceContentPath }).ToArray();
    foreach (var root in Hl2RtxMountService.GeneratedOverlayRoots)
    {
        var candidates = sources.Select(source => Path.Combine(source, root)).Where(Directory.Exists).ToArray();
        var destination = Path.Combine(layout.CompatibilityAddonPath, root);
        if (candidates.Length != 0) ValidateOverlayDirectory(root, candidates, destination);
        else if (Path.Exists(destination)) throw new InvalidDataException($"Unexpected overlay root: {destination}");
    }
    ValidateRemixDirectory(remixSource, remixTarget, fixes, true);
}

// Match upstream merge priority, checking expected children as well as link destinations.
static void ValidateOverlayDirectory(string virtualPath, IReadOnlyList<string> candidates, string destination)
{
    if (!Directory.Exists(destination) || new DirectoryInfo(destination).LinkTarget != null)
        throw new InvalidDataException($"Expected a physical merged overlay directory: {destination}");
    var children = candidates.SelectMany(path => new DirectoryInfo(path).EnumerateFileSystemInfos())
        .Where(child => virtualPath != "materials" || !new[] { "vgui", "dev", "editor", "perftest", "tools" }.Contains(child.Name, StringComparer.OrdinalIgnoreCase))
        .GroupBy(child => child.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    ValidateNames(destination, children.Select(group => group.Key));
    foreach (var group in children)
    {
        var first = group.First();
        var target = Path.Combine(destination, first.Name);
        var directories = group.OfType<DirectoryInfo>().Select(directory => directory.FullName).ToArray();
        if (first is FileInfo || directories.Length == 1) ValidateLink(target, first.FullName, first is DirectoryInfo);
        else ValidateOverlayDirectory(virtualPath + "/" + first.Name, directories, target);
    }
}

static void ValidateRemixDirectory(string source, string destination, string fixes, bool root)
{
    if (!Directory.Exists(destination)) throw new DirectoryNotFoundException($"Missing Remix directory: {destination}");
    if (new DirectoryInfo(destination).LinkTarget != null)
    {
        if (root) throw new InvalidDataException($"Remix mount root must contain local USDA copies: {destination}");
        ValidateLink(destination, source, true);
        return;
    }
    var files = Directory.GetFiles(source);
    var directories = Directory.GetDirectories(source);
    var replacementFiles = root ? Directory.GetFiles(fixes, "*.usda") : Array.Empty<string>();
    ValidateNames(destination, files.Concat(directories).Concat(replacementFiles).Select(path => Path.GetFileName(path)).Distinct(StringComparer.OrdinalIgnoreCase));
    foreach (var file in files.Concat(replacementFiles).DistinctBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase))
    {
        var target = Path.Combine(destination, Path.GetFileName(file));
        if (root && Path.GetExtension(file).Equals(".usda", StringComparison.OrdinalIgnoreCase))
        {
            var replacement = Path.Combine(fixes, Path.GetFileName(file));
            var expected = File.Exists(replacement) ? replacement : file;
            if (!File.Exists(target) || new FileInfo(target).LinkTarget != null ||
                !SHA256.HashData(File.ReadAllBytes(target)).SequenceEqual(SHA256.HashData(File.ReadAllBytes(expected))))
                throw new InvalidDataException($"Root USDA differs from the supplied sources/fixes or is a link: {target}");
        }
        else ValidateLink(target, file, false);
    }
    foreach (var directory in directories)
        ValidateRemixDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)), fixes, false);
}

static void ValidateNames(string directory, IEnumerable<string> expected)
{
    var actual = Directory.EnumerateFileSystemEntries(directory).Select(path => Path.GetFileName(path)).ToHashSet(StringComparer.OrdinalIgnoreCase);
    if (!actual.SetEquals(expected)) throw new InvalidDataException($"Missing or unexpected mount entries in: {directory}");
}

static void ValidateLink(string path, string expected, bool directory)
{
    FileSystemInfo info = directory ? new DirectoryInfo(path) : new FileInfo(path);
    if (!info.Exists || info.LinkTarget == null || !PathsEqual(info.ResolveLinkTarget(true)?.FullName ?? "", expected))
        throw new InvalidDataException($"Missing or incorrect symbolic link: {path}; expected target: {expected}");
}

static void RequirePhysicalPath(string game, string target)
{
    for (var path = Path.GetFullPath(target); IsWithin(path, game); path = Path.GetDirectoryName(path)!)
    {
        if (Path.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"Refusing to write through a symbolic link or junction: {path}");
        if (PathsEqual(path, game)) break;
    }
}

static bool PathsEqual(string first, string second) => string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(first)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(second)), StringComparison.OrdinalIgnoreCase);
static bool IsWithin(string path, string root) => PathsEqual(path, root) || Path.GetFullPath(path).StartsWith(Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
