{ pkgs, lib, ... }:
let
  bands =
    lib.imap0
      (i: freq: {
        type = "builtin";
        name = "band${toString i}";
        label = "bq_peaking";
        control = {
          Freq = freq;
          Q = 1.414;
          Gain = 0.0;
        };
      })
      [
        31.5
        63
        125
        250
        500
        1000
        2000
        4000
        8000
        16000
      ];
  nodes = [
    {
      type = "builtin";
      name = "preamp";
      label = "linear";
      control.Mult = 1.0;
    }
  ]
  ++ bands;
  fragment = pkgs.writeText "equalizer.json" (
    builtins.toJSON {
      "context.modules" = [
        {
          name = "libpipewire-module-filter-chain";
          args = {
            "node.description" = "RaspPi equalizer";
            "audio.channels" = 2;
            "audio.position" = [
              "FL"
              "FR"
            ];
            "filter.graph" = {
              inherit nodes;
              links = lib.imap0 (i: band: {
                output = "${(builtins.elemAt nodes i).name}:Out";
                input = "${band.name}:In";
              }) bands;
            };
            "capture.props" = {
              "node.name" = "rasppi-eq";
              "media.class" = "Audio/Sink";
            };
            "playback.props" = {
              "node.name" = "rasppi-eq-output";
              "node.passive" = true;
              "target.object" = "rasppi-dac";
              "node.dont-fallback" = true;
            };
          };
        }
      ];
    }
  );
  start = pkgs.writeShellScript "start-equalizer" ''
    set -eu
    export PIPEWIRE_CONFIG_DIR="$RUNTIME_DIRECTORY"
    ${pkgs.coreutils}/bin/mkdir -p "$RUNTIME_DIRECTORY/filter-chain.conf.d"
    ${pkgs.coreutils}/bin/cp ${pkgs.pipewire}/share/pipewire/filter-chain.conf "$RUNTIME_DIRECTORY/"
    curve="$STATE_DIRECTORY/equalizer.json"
    if [ ! -f "$curve" ]; then curve=/dev/null; fi
    ${pkgs.jq}/bin/jq --slurpfile saved "$curve" '
      if ($saved | length) == 0 then . else
        ."context.modules"[0].args."filter.graph".nodes |=
        (.[0].control.Mult = $saved[0].preamp |
         reduce range(0;10) as $i (. ; .[$i+1].control.Gain = $saved[0].gains[$i]))
      end
    ' ${fragment} > "$RUNTIME_DIRECTORY/filter-chain.conf.d/rasppi.conf"
    exec ${pkgs.pipewire}/bin/pipewire -c filter-chain.conf
  '';
in
{
  systemd.user.services.rasppi-equalizer = {
    description = "Shared ten-band equalizer for Spotify and YouTube";
    unitConfig.ConditionUser = "pita";
    after = [ "pipewire.service" ];
    requires = [ "pipewire.service" ];
    partOf = [ "pipewire.service" ];
    wantedBy = [ "default.target" ];
    serviceConfig = {
      ExecStart = start;
      Restart = "always";
      RestartSec = 2;
      RuntimeDirectory = "rasppi-eq";
      StateDirectory = "rasppi-control-panel";
      StateDirectoryMode = "0700";
      UMask = "0077";
    };
  };
}
