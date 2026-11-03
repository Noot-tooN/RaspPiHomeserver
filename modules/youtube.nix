{ pkgs, ... }:
let
  python = pkgs.python3.withPackages (ps: [ ps.websockets ]);
in
{
  nixpkgs.config.allowUnfree = true;
  systemd.user.services.youtube-tv = {
    description = "YouTube TV receiver with startup naming and page health checks";
    wantedBy = [ "default.target" ];
    requires = [ "rasppi-audio-ready.service" ];
    after = [ "rasppi-audio-ready.service" ];
    unitConfig = {
      ConditionUser = "pita";
      StartLimitIntervalSec = 0;
    };
    environment = {
      PULSE_SERVER = "unix:%t/pulse/native";
      PULSE_SINK = "rasppi-dac";
      PYTHONUNBUFFERED = "1";
    };
    serviceConfig = {
      ExecStart = "${pkgs.xvfb-run}/bin/xvfb-run -a -s '-screen 0 1280x720x24 -nolisten tcp' ${python}/bin/python ${../scripts/youtube_receiver.py} --browser ${pkgs.brave}/bin/brave --name-script ${../youtube/receiver-name.js} --profile %h/.config/brave-youtube-tv";
      Restart = "always";
      RestartSec = 15;
      TimeoutStopSec = 15;
      KillMode = "control-group";
      UMask = "0077";
    };
  };
}
