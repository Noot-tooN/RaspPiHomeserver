{ config, lib, pkgs, ... }:
let
  cominNix = pkgs.writeShellScriptBin "nix" ''
    exec ${pkgs.bash}/bin/bash ${../scripts/comin-nix.sh} ${config.nix.package}/bin/nix "$@"
  '';
  backgroundService = {
    Slice = "nixmaintenance.slice";
    Nice = 15;
    # Filesystem journal progress must not depend on a starved write queue.
    # Limit buffered write bursts below instead of deprioritizing SD writeback.
    IOSchedulingClass = "best-effort";
    IOSchedulingPriority = 4;
  };
in
{
  # Nix 2.35 evaluates flake sources lazily instead of eagerly unpacking the
  # entire nixpkgs tree into /nix/store, which stalls this Pi's SD card.
  # Comin's service PATH follows config.nix.package as well.
  nix.package = pkgs.nixVersions.latest;

  services.comin = {
    enable = true;
    hostname = "rasppi";
    # A cold nixpkgs tree contains many small files; SD I/O can take
    # longer than the default 30-minute deadline, especially for both inputs.
    evalTimeout = 5400;
    buildTimeout = 5400;
    remotes = [
      {
        name = "origin";
        url = "https://github.com/Noot-tooN/RaspPiHomeserver.git";
        branches.main.name = "master";
        # The Pi's calendar timer triggers the fetch that starts evaluation.
        poller.period = 0;
      }
    ];
  };

  systemd.timers.comin-fetch = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "*-*-* 03:00:00 Europe/Belgrade";
      AccuracySec = "1s";
      Persistent = false;
    };
  };
  systemd.services.comin-fetch = {
    description = "Check for Raspberry Pi updates";
    # Respect an administrator stopping Comin for a rollback.
    unitConfig.Requisite = "comin.service";
    after = [ "comin.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${lib.getExe config.services.comin.package} fetch";
    };
  };

  # Evaluation/downloads may run inside Comin as root; builds requested by
  # other users run in nix-daemon. Limit their combined use of the 2 GB Pi.
  systemd.slices.nixmaintenance = {
    description = "Background Nix maintenance";
    sliceConfig = {
      CPUWeight = 10;
      CPUQuota = "100%";
      IOWeight = 100;
      # Repeated direct reclaim at MemoryHigh amplified the SD writeback stall.
      # Retain a hard budget, but do not continuously throttle the evaluator.
      MemoryHigh = "infinity";
      MemoryMax = "1100M";
      MemorySwapMax = "512M";
    };
  };
  # Nixpkgs extraction can otherwise accumulate ~90 MiB of dirty small files
  # and exhaust the ext4 journal, blocking unrelated reads and SSH sessions.
  # Start writeback early and pace writers before a large backlog develops.
  boot.kernel.sysctl = {
    "vm.dirty_background_bytes" = 4 * 1024 * 1024;
    "vm.dirty_bytes" = 16 * 1024 * 1024;
  };
  # Preserve the user services' working set when Nix fills the file cache.
  # This is best-effort reclaim protection, not a memory reservation or limit.
  systemd.slices.user.sliceConfig.MemoryLow = "512M";

  systemd.services.comin.path = lib.mkBefore [ cominNix ];
  systemd.services.comin.serviceConfig = backgroundService // {
    # Do not silently run unbounded after booting an older kernel command line.
    ExecCondition = "${pkgs.gnugrep}/bin/grep -qw memory /sys/fs/cgroup/cgroup.controllers";
  };
  systemd.services.nix-daemon.serviceConfig = {
    inherit (backgroundService) Slice Nice;
  };
  nix.daemonIOSchedClass = "best-effort";
  nix.daemonIOSchedPriority = 4;
  systemd.services.nix-gc.serviceConfig = backgroundService;

  # Substitutions otherwise default to 16 parallel downloads/unpacks. Store
  # deduplication adds another pass over every new file on a slow SD card.
  nix.settings = {
    extra-substituters = [ "https://github.com/Noot-tooN/RaspPiHomeserver/releases/download/nix-cache" ];
    extra-trusted-public-keys = [ (builtins.replaceStrings [ "\n" ] [ "" ] (builtins.readFile ../keys/cache.pub)) ];
    narinfo-cache-negative-ttl = 60;
    max-substitution-jobs = 1;
    http-connections = 4;
    cores = 1;
    auto-optimise-store = false;
  };
}
