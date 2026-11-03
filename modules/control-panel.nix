{ config, pkgs, ... }:
let
  panel = pkgs.callPackage ../apps/control-panel/package.nix { };
in
{
  systemd.user.services.rasppi-control-panel = {
    description = "RaspPi audio and app control panel";
    wantedBy = [ "default.target" ];
    unitConfig = {
      ConditionUser = "pita";
      StartLimitIntervalSec = 0;
    };
    environment.PULSE_SERVER = "unix:%t/pulse/native";
    serviceConfig = {
      # Bind specifically to Tailscale, never all LAN interfaces. Before initial
      # enrollment the service retries until the interface has an address.
      ExecStart = "${panel}/bin/rasppi-control-panel --interface ${config.services.tailscale.interfaceName} --allowed-hosts ${config.networking.hostName} --pactl ${pkgs.pulseaudio}/bin/pactl --systemctl ${pkgs.systemd}/bin/systemctl";
      Restart = "always";
      RestartSec = 15;
      TimeoutStopSec = 5;
      NoNewPrivileges = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = "read-only";
      UMask = "0077";
      MemoryMax = "128M";
      TasksMax = 32;
    };
  };
  # tailscale0 is already trusted. No LAN firewall port or sudo rule is added.
}
