{ pkgs, ... }:
let
  panel = pkgs.callPackage ../apps/control-panel/package.nix { };
  python = pkgs.python3.withPackages (ps: [ ps.websockets ]);
  pairing = pkgs.writeShellScript "youtube-pairing" ''
    exec ${python}/bin/python ${../scripts}/youtube_pairing.py
  '';
  player = pkgs.writeShellScript "youtube-control" ''
    exec ${python}/bin/python ${../scripts}/youtube_control.py --script ${../youtube/player-control.js} "$@"
  '';
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
      # Only Caddy exposes this service, at the exact public HTTPS origin.
      ExecStart = "${panel}/bin/rasppi-control-panel --listen 127.0.0.1:8090 --public-origin https://rasppi.tail0fa2e4.ts.net --pactl ${pkgs.pulseaudio}/bin/pactl --systemctl ${pkgs.systemd}/bin/systemctl --youtube-pairing ${pairing} --youtube-control ${player}";
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
  # No backend firewall port or sudo rule is added.
}
