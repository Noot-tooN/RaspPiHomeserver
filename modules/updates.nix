{ pkgs, ... }:
let
  backgroundService = {
    Slice = "nixmaintenance.slice";
    Nice = 15;
    # BFQ serves idle-class queues only after ordinary traffic. Keep updates
    # low priority without starving filesystem metadata operations.
    IOSchedulingClass = "best-effort";
    IOSchedulingPriority = 7;
  };
in
{
  services.comin = {
    enable = true;
    hostname = "rasppi";
    # A cold nixpkgs tree contains many small files; bounded SD I/O can take
    # longer than the default 30-minute deadline, especially for both inputs.
    evalTimeout = 5400;
    buildTimeout = 5400;
    remotes = [
      {
        name = "origin";
        url = "https://github.com/Noot-tooN/RaspPiHomeserver.git";
        branches.main.name = "master";
      }
    ];
  };

  # Evaluation/downloads may run inside Comin as root; builds requested by
  # other users run in nix-daemon. Limit their combined use of the 2 GB Pi.
  systemd.slices.nixmaintenance = {
    description = "Background Nix maintenance";
    sliceConfig = {
      CPUWeight = 10;
      CPUQuota = "100%";
      IOWeight = 10;
      MemoryHigh = "800M";
      MemoryMax = "1100M";
      MemorySwapMax = "512M";
      # Resolve the backing disk from /, so SD and recovery USB boots work.
      IOReadBandwidthMax = "/ 8M";
      IOWriteBandwidthMax = "/ 2M";
      IOReadIOPSMax = "/ 300";
      IOWriteIOPSMax = "/ 100";
    };
  };
  systemd.services.comin.serviceConfig = backgroundService // {
    # Do not silently run unbounded after booting an older kernel command line.
    ExecCondition = "${pkgs.gnugrep}/bin/grep -qw memory /sys/fs/cgroup/cgroup.controllers";
  };
  systemd.services.nix-daemon.serviceConfig = {
    inherit (backgroundService) Slice Nice;
  };
  nix.daemonIOSchedClass = "best-effort";
  nix.daemonIOSchedPriority = 7;
  systemd.services.nix-gc.serviceConfig = backgroundService;

  # Substitutions otherwise default to 16 parallel downloads/unpacks. Store
  # deduplication adds another pass over every new file on a slow SD card.
  nix.settings = {
    max-substitution-jobs = 1;
    http-connections = 4;
    cores = 1;
    auto-optimise-store = false;
  };
}
